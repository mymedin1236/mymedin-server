import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import AppointmentType from "../models/AppointmentType.js";
import LoginEvent from "../models/LoginEvent.js";
import { protect, requireStaff, resolveClinic, clinicId } from "../middleware/auth.js";
import { sendMail } from "../utils/mailer.js";

const router = express.Router();

// Whether the request came from the installed PWA (standalone) vs a browser.
const isPwa = (req) => req.headers["x-display-mode"] === "standalone";

// Best-effort audit log of a login attempt (never blocks/fails the request).
const logLogin = (req, { user, identifier, success, reason }) => {
  LoginEvent.create({
    user: user?._id,
    name: user?.name,
    identifier,
    role: user?.role,
    success,
    reason,
    pwa: isPwa(req),
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  }).catch((e) => console.error("[loginEvent]", e?.message));
};

// remember=true (default) keeps the user signed in for JWT_EXPIRES_IN (15d);
// remember=false issues a short-lived token for shared/public devices.
const signToken = (user, remember = true) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: remember ? process.env.JWT_EXPIRES_IN || "15d" : "1d",
  });

// The UI shows "Dr. <name>", so strip a leading "Dr"/"Dr." the doctor may have typed.
const stripDrPrefix = (name = "") => name.replace(/^\s*dr\b\.?\s*/i, "").trim();

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role,
      phone,
      dateOfBirth,
      address,
      // Doctor profile fields
      clinicName,
      about,
      specialization,
      yearsOfExperience,
      availability,
      latitude,
      longitude,
      image,
    } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "name, email, password, role are required" });
    }
    if (!["doctor", "client", "vendor", "assistant"].includes(role)) {
      return res.status(400).json({ message: "role must be doctor, client, vendor, or assistant" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ message: "Email already registered" });

    const trimmedPhone = phone?.trim();
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone });
      if (phoneExists) return res.status(409).json({ message: "Phone already registered" });
    }

    // Build doctor-only profile data (incl. GeoJSON location from lat/lng) when registering as a doctor
    const doctorFields = {};
    if (role === "doctor") {
      if (clinicName) doctorFields.clinicName = clinicName;
      if (about) doctorFields.about = about;
      if (specialization) doctorFields.specialization = specialization;
      if (image) doctorFields.image = image;
      if (yearsOfExperience != null && yearsOfExperience !== "") {
        doctorFields.yearsOfExperience = Number(yearsOfExperience);
      }
      if (Array.isArray(availability)) doctorFields.availability = availability;
      if (latitude != null && longitude != null && latitude !== "" && longitude !== "") {
        doctorFields.location = {
          type: "Point",
          coordinates: [Number(longitude), Number(latitude)],
        };
      }
    }

    const user = await User.create({
      name: role === "doctor" ? stripDrPrefix(name) : name,
      email,
      password,
      role,
      phone: trimmedPhone || undefined,
      dateOfBirth,
      address,
      ...doctorFields,
    });
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    // Accept an email OR phone number under `identifier` (falls back to `email`)
    const { identifier, email, password, remember } = req.body;
    const id = (identifier ?? email ?? "").trim();
    if (!id || !password) {
      return res.status(400).json({ message: "Email/phone and password required" });
    }
    // An identifier containing "@" is treated as an email, otherwise as a phone
    const query = id.includes("@")
      ? { email: id.toLowerCase() }
      : { phone: id };
    const user = await User.findOne(query);
    if (!user) {
      logLogin(req, { identifier: id, success: false, reason: "no such user" });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      logLogin(req, { user, identifier: id, success: false, reason: "wrong password" });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    logLogin(req, { user, identifier: id, success: true });
    // Track how the user accessed the app (PWA vs browser).
    const pwa = isPwa(req);
    if (user.lastLoginPwa !== pwa) {
      User.updateOne({ _id: user._id }, { $set: { lastLoginPwa: pwa } }).catch(() => {});
    }
    const token = signToken(user, remember !== false);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/forgot-password  -> email a time-limited reset link.
// Accepts `identifier` (email OR phone). If the matched account has no email on
// file (e.g. a phone-only patient), the client is asked to supply one via
// `newEmail`, which we save to the account and use to send the link.
router.post("/forgot-password", async (req, res) => {
  try {
    const { identifier, email, newEmail } = req.body;
    const raw = (identifier ?? email ?? "").toString().trim();
    if (!raw) return res.status(400).json({ message: "Email or phone is required" });

    // Email lookups contain "@"; otherwise treat it as a phone number.
    const byEmail = raw.includes("@");
    const user = byEmail
      ? await User.findOne({ email: raw.toLowerCase() })
      : await User.findOne({ phone: raw.replace(/\D/g, "") });

    const generic = "If that account exists, a reset link has been sent.";

    if (user) {
      let to = user.email;

      // Phone-only account with no email: collect one, save it, send there.
      if (!to) {
        const provided = (newEmail || "").toString().trim().toLowerCase();
        if (!provided) {
          // Signal the client to ask for an email for this account.
          return res.json({
            needEmail: true,
            message: "We don't have an email on file for this account. Enter one to receive your reset link.",
          });
        }
        if (!EMAIL_RE.test(provided)) {
          return res.status(400).json({ message: "Enter a valid email address." });
        }
        const clash = await User.findOne({ email: provided, _id: { $ne: user._id } });
        if (clash) {
          return res.status(409).json({ message: "That email is already used by another account." });
        }
        user.email = provided; // persisted with the token save below
        to = provided;
      }

      const token = crypto.randomBytes(32).toString("hex");
      user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save();

      const base = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
        .split(",")[0]
        .trim()
        .replace(/\/+$/, "");
      const link = `${base}/reset-password?token=${token}`;
      const result = await sendMail({
        to,
        subject: "Reset your MyMedin password",
        text: `We received a request to reset your password.\n\nUse this link within 1 hour:\n${link}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>We received a request to reset your password.</p>
               <p>Use this link within 1 hour:</p>
               <p><a href="${link}">${link}</a></p>
               <p>If you didn't request this, you can ignore this email.</p>`,
      });
      if (!result.delivered) {
        console.error(`[forgot-password] reset email to ${to} was NOT delivered: ${result.reason}`);
      }
      // Opt-in diagnostics: set MAIL_DEBUG=true to learn whether the email
      // actually went out (and why not).
      if (process.env.MAIL_DEBUG === "true") {
        return res.json({
          message: generic,
          debug: { found: true, delivered: result.delivered, reason: result.reason || null },
        });
      }
    } else if (process.env.MAIL_DEBUG === "true") {
      return res.json({ message: generic, debug: { found: false } });
    }

    // Generic response (when an account was found and emailed, or not found at all).
    res.json({ message: generic });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/reset-password  -> set a new password using a valid token
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetTokenHash: hash,
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    user.password = password; // re-hashed by the pre-save hook
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();

    res.json({ message: "Password updated. You can now sign in." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", protect, async (req, res) => {
  // Refresh how the user is accessing the app (PWA vs browser) on each app open.
  const pwa = isPwa(req);
  if (req.user.lastLoginPwa !== pwa) {
    req.user.lastLoginPwa = pwa;
    User.updateOne({ _id: req.user._id }, { $set: { lastLoginPwa: pwa } }).catch(() => {});
  }
  res.json({ user: req.user });
});

// POST /api/auth/change-password -> change own password (verifies current one)
router.post("/change-password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }
    const user = await User.findById(req.user._id);
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ message: "Current password is incorrect" });
    user.password = newPassword; // re-hashed by the pre-save hook
    await user.save();
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/auth/me -> update own profile (role-aware fields)
router.put("/me", protect, async (req, res) => {
  try {
    const u = req.user;
    const b = req.body;

    if (b.name != null) u.name = u.role === "doctor" ? stripDrPrefix(b.name) : b.name;

    if (b.email !== undefined) {
      const cleanEmail = b.email.trim().toLowerCase() || undefined;
      if (cleanEmail) {
        const exists = await User.findOne({ email: cleanEmail, _id: { $ne: u._id } });
        if (exists) return res.status(409).json({ message: "Email already in use" });
      }
      u.email = cleanEmail;
    }

    if (b.phone != null) {
      const trimmed = b.phone.trim();
      if (trimmed) {
        if (!/^\d{11}$/.test(trimmed)) {
          return res.status(400).json({ message: "Phone number must be exactly 11 digits." });
        }
        const exists = await User.findOne({ phone: trimmed, _id: { $ne: u._id } });
        if (exists) return res.status(409).json({ message: "Phone already in use" });
        u.phone = trimmed;
      } else {
        u.phone = undefined;
      }
    }

    if (u.role === "client") {
      if (b.dateOfBirth !== undefined) u.dateOfBirth = b.dateOfBirth || undefined;
      if (b.address !== undefined) u.address = b.address;
    }

    if (u.role === "vendor") {
      if (b.companyName !== undefined) u.companyName = b.companyName;
    }

    // Profile photo — only doctors and assistants can set/clear their own.
    if (b.image !== undefined && (u.role === "doctor" || u.role === "assistant")) {
      u.image = b.image || undefined;
    }

    if (u.role === "doctor") {
      if (b.clinicName !== undefined) u.clinicName = b.clinicName;
      if (b.specialization !== undefined) u.specialization = b.specialization;
      if (b.about !== undefined) u.about = b.about;
      if (b.address !== undefined) u.address = b.address;
      if (b.yearsOfExperience !== undefined && b.yearsOfExperience !== "") {
        u.yearsOfExperience = Number(b.yearsOfExperience);
      }
      if (Array.isArray(b.availability)) u.availability = b.availability;
      if (b.slotDuration != null && b.slotDuration !== "") {
        const d = Number(b.slotDuration);
        if (Number.isFinite(d) && d >= 5 && d <= 120) u.slotDuration = d;
      }
      if (
        b.latitude != null &&
        b.longitude != null &&
        b.latitude !== "" &&
        b.longitude !== ""
      ) {
        u.location = {
          type: "Point",
          coordinates: [Number(b.longitude), Number(b.latitude)],
        };
      }
    }

    await u.save();
    res.json({ user: u });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---- Clinic settings (shared by the doctor and their assistants) ----
// Clinic hours / slot length / location live on the clinic OWNER (doctor)
// record. An assistant acts on behalf of that doctor, so both roles read and
// write the same clinic-owner document via clinicId().

// GET /api/auth/clinic-settings -> the clinic's operational settings.
router.get("/clinic-settings", protect, requireStaff, resolveClinic, async (req, res) => {
  try {
    const doctorId = clinicId(req.user);
    const [owner, appointmentTypes] = await Promise.all([
      User.findById(doctorId)
        .select("clinicName availability slotDuration dayOverrides location")
        .lean(),
      AppointmentType.find({ doctor: doctorId }).sort({ order: 1, createdAt: 1 }).lean(),
    ]);
    if (!owner) return res.status(404).json({ message: "Clinic not found" });
    res.json({
      clinicName: owner.clinicName || "",
      availability: owner.availability || [],
      slotDuration: owner.slotDuration || 15,
      dayOverrides: owner.dayOverrides || [],
      location: owner.location || null,
      appointmentTypes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/auth/clinic-settings -> update the clinic's operational settings.
router.put("/clinic-settings", protect, requireStaff, resolveClinic, async (req, res) => {
  try {
    const owner = await User.findById(clinicId(req.user));
    if (!owner) return res.status(404).json({ message: "Clinic not found" });
    const b = req.body;

    // Appointment types this clinic actually owns — a bracket may only point at
    // one of these, so a crafted request can't attach another clinic's type
    // (and with it another clinic's slot length) to these hours.
    const ownTypeIds = new Set(
      (await AppointmentType.find({ doctor: owner._id }).select("_id").lean()).map((t) => String(t._id))
    );
    const validType = (id) => (id && ownTypeIds.has(String(id)) ? id : undefined);

    if (Array.isArray(b.availability)) {
      // Keep only well-formed { day, start, end } brackets. A day may repeat (a
      // morning + an evening session, or a consultation bracket followed by a
      // surgery bracket), so we don't collapse by day here.
      const hhmm = /^\d{2}:\d{2}$/;
      owner.availability = b.availability
        .filter((a) => a && a.day && hhmm.test(a.start || "") && hhmm.test(a.end || "") && a.start < a.end)
        .map((a) => ({
          day: a.day,
          start: a.start,
          end: a.end,
          appointmentType: validType(a.appointmentType),
        }));
    }
    if (b.slotDuration != null && b.slotDuration !== "") {
      const d = Number(b.slotDuration);
      if (Number.isFinite(d) && d >= 5 && d <= 120) owner.slotDuration = d;
    }
    if (Array.isArray(b.dayOverrides)) {
      // Keep only well-formed, current-or-future entries so the list can't grow
      // unbounded with stale past exceptions.
      const todayStr = new Date().toISOString().slice(0, 10);
      const hhmmOv = /^\d{2}:\d{2}$/;
      owner.dayOverrides = b.dayOverrides
        .filter((o) => o && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && o.date >= todayStr)
        .map((o) => {
          if (o.closed) return { date: o.date, closed: true, blocks: [] };
          // Prefer the typed `blocks` array; accept the legacy single window so
          // an older client (or an override saved before types) still saves.
          const raw = Array.isArray(o.blocks) && o.blocks.length ? o.blocks : [o];
          const blocks = raw
            .filter((x) => x && hhmmOv.test(x.start || "") && hhmmOv.test(x.end || "") && x.start < x.end)
            .map((x) => ({
              start: x.start,
              end: x.end,
              appointmentType: validType(x.appointmentType),
            }));
          return { date: o.date, closed: false, blocks };
        })
        .filter((o) => o.closed || o.blocks.length);
    }
    if (
      b.latitude != null &&
      b.longitude != null &&
      b.latitude !== "" &&
      b.longitude !== ""
    ) {
      owner.location = {
        type: "Point",
        coordinates: [Number(b.longitude), Number(b.latitude)],
      };
    }

    await owner.save();
    const appointmentTypes = await AppointmentType.find({ doctor: owner._id })
      .sort({ order: 1, createdAt: 1 })
      .lean();
    res.json({
      clinicName: owner.clinicName || "",
      availability: owner.availability || [],
      slotDuration: owner.slotDuration || 15,
      dayOverrides: owner.dayOverrides || [],
      location: owner.location || null,
      appointmentTypes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/agreement — the clinic's agreement status. Doctor-only: the
// billing/agreement status is the owner's and is hidden from assistants.
router.get("/agreement", protect, async (req, res) => {
  try {
    if (req.user.role !== "doctor") {
      return res.status(403).json({ message: "Only the clinic owner can view the agreement." });
    }
    const owner = await User.findById(req.user._id)
      .select("agreement clinicName name")
      .lean();
    if (!owner) return res.status(404).json({ message: "Clinic not found" });
    res.json({
      agreement: owner.agreement?.acceptedAt ? owner.agreement : null,
      clinicName: owner.clinicName || "",
      ownerName: owner.name || "",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/agreement/accept — doctor e-signs the service agreement.
router.post("/agreement/accept", protect, async (req, res) => {
  try {
    if (req.user.role !== "doctor") {
      return res.status(403).json({ message: "Only the clinic owner can sign the agreement." });
    }
    const name = String(req.body.name || "").trim();
    const version = String(req.body.version || "").trim();
    if (name.length < 2) {
      return res.status(400).json({ message: "Please type your full name to sign." });
    }
    const u = req.user;
    u.agreement = { acceptedAt: new Date(), name, version: version || "v1" };
    await u.save();
    res.json({ user: u });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
