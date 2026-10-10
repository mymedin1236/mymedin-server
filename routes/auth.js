import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import AppointmentType from "../models/AppointmentType.js";
import LoginEvent from "../models/LoginEvent.js";
import { protect, requireStaff, resolveClinic, clinicId } from "../middleware/auth.js";
import { sendMail } from "../utils/mailer.js";
import { sendWhatsApp, whatsappStatus, SIGNATURE } from "../utils/whatsapp.js";

const router = express.Router();

// Welcome a newly self-registered user over email and WhatsApp. Self-signup
// previously confirmed nothing at all — the account simply existed. Entirely
// best-effort: both senders swallow their own errors, and this is never
// awaited, so a dead mailer or gateway can't fail someone's registration.
const sendWelcome = (user) => {
  const loginUrl =
    (process.env.CLIENT_ORIGIN || "http://localhost:5173")
      .split(",")[0]
      .trim()
      .replace(/\/+$/, "") + "/login";
  const isDoctor = user.role === "doctor";
  const greeting = isDoctor ? `Dr. ${user.name}` : user.name;
  const subject = isDoctor ? "Your MyMedin clinic account" : "Welcome to MyMedin";
  // Patient copy would be wrong for a vendor or an assistant, who have neither
  // appointments nor treatments — they get the plain version.
  const body = {
    doctor:
      `Your clinic account is ready. Sign in at ${loginUrl} to set your clinic hours, ` +
      `add patients and start recording treatments.`,
    client:
      `Your account is ready. Sign in at ${loginUrl} to see your appointments. ` +
      `We'll send reminders and treatment updates here.`,
  }[user.role] || `Your account is ready. Sign in at ${loginUrl} to get started.`;
  // No "reply to this message" — nothing reads inbound WhatsApp on the gateway.
  const text = `Hi ${greeting}, welcome to MyMedin.\n\n${body}`;

  if (user.email) {
    sendMail({ to: user.email, subject, text, html: text.replace(/\n/g, "<br/>") }).catch((e) =>
      console.error("[welcome] email:", e?.message)
    );
  }
  if (user.phone) {
    sendWhatsApp({ to: user.phone, text }).catch((e) =>
      console.error("[welcome] whatsapp:", e?.message)
    );
  }
};

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
    sendWelcome(user); // fire-and-forget; never blocks or fails the signup
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

// Every way a patient might type the same number (0319…, +92 319…, 92319…)
// mapped to the formats we may have stored, so the lookup finds them.
const CC = process.env.WHATSAPP_COUNTRY_CODE || "92";
function phoneCandidates(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 10) return [];
  const local = d.slice(-10); // 3191234567
  return [...new Set([d, `0${local}`, `${CC}${local}`, `+${CC}${local}`])];
}

const OTP_TTL_MS = 10 * 60 * 1000; // code valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5; // wrong guesses before the code is burned
const OTP_RESEND_MS = 60 * 1000; // minimum gap between codes
const OTP_MAX_SENDS = 5; // codes per phone per hour
const otpHash = (userId, code) =>
  crypto.createHash("sha256").update(`${userId}:${code}`).digest("hex");

const clientBase = () =>
  (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(",")[0].trim().replace(/\/+$/, "");

// POST /api/auth/forgot-password
// - Email identifier -> a time-limited reset link by email (method: "link").
// - Phone identifier -> a 6-digit code on WhatsApp (method: "otp"), entered on
//   the same screen via /reset-password-otp. If WhatsApp can't deliver it and
//   the account has an email, the reset link goes there as a backup.
// Codes and links only ever go to contact details already on the account — we
// never accept a new address here, so knowing someone's phone number is not
// enough to take over their account. Responses are identical whether or not
// the account exists, so the page can't be used to probe who is registered.
router.post("/forgot-password", async (req, res) => {
  try {
    const { identifier, email } = req.body;
    const raw = (identifier ?? email ?? "").toString().trim();
    if (!raw) return res.status(400).json({ message: "Email or phone is required" });

    const byEmail = raw.includes("@");

    if (byEmail) {
      const user = await User.findOne({ email: raw.toLowerCase() });
      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
        user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await user.save();
        const r = await sendResetLink(user.email, token);
        if (!r.delivered) console.error(`[forgot-password] link for ${user._id} NOT delivered: ${r.reason}`);
      }
      return res.json({ method: "link", message: "If that account exists, a reset link has been sent." });
    }

    const candidates = phoneCandidates(raw);
    if (!candidates.length) return res.status(400).json({ message: "Enter a valid phone number." });

    // Checked before the account lookup, so the answer reveals nothing about
    // whether the number is registered — only that WhatsApp is unavailable.
    const wa = await whatsappStatus();
    if (!wa.ok) {
      console.error(`[forgot-password] WhatsApp unavailable: ${wa.status}`);
      return res.status(503).json({
        message:
          "We can't send WhatsApp codes right now. Please try again in a few minutes, or contact your clinic to reset your password.",
      });
    }

    const generic = {
      method: "otp",
      resendIn: OTP_RESEND_MS / 1000,
      expiresIn: OTP_TTL_MS / 1000,
      message: "If that number is registered, we've sent a 6-digit code to it on WhatsApp.",
    };

    const user = await User.findOne({ phone: { $in: candidates } });
    if (!user) return res.json(generic);

    const now = Date.now();
    const o = user.resetOtp || {};
    // Over the resend gap or hourly cap: send nothing, but answer exactly as
    // for any other number so the limits don't reveal that this one exists.
    // (The page enforces the 60s resend timer on its side.)
    const inWindow = o.windowStart && now - o.windowStart.getTime() < 60 * 60 * 1000;
    if (
      (o.sentAt && now - o.sentAt.getTime() < OTP_RESEND_MS) ||
      (inWindow && (o.sends || 0) >= OTP_MAX_SENDS)
    ) {
      return res.json(generic);
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    user.resetOtp = {
      hash: otpHash(user._id, code),
      expires: new Date(now + OTP_TTL_MS),
      attempts: 0,
      sentAt: new Date(now),
      sends: inWindow ? (o.sends || 0) + 1 : 1,
      windowStart: inWindow ? o.windowStart : new Date(now),
    };
    await user.save();

    const waResult = await sendWhatsApp({
      to: user.phone,
      text:
        `🔐 *MyMedin password reset*\n\n` +
        `Your code is: *${code}*\n\n` +
        `• Valid for 10 minutes\n` +
        `• Never share this code with anyone — MyMedin staff will never ask for it\n\n` +
        `If you didn't request this, you can ignore this message.\n\n${SIGNATURE}`,
    });
    if (!waResult.delivered) {
      console.error(`[forgot-password] OTP for ${user._id} NOT delivered: ${waResult.reason}`);
      // Backup: email them a link if they have an address on file.
      if (user.email) {
        const token = crypto.randomBytes(32).toString("hex");
        user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
        user.resetTokenExpires = new Date(now + 60 * 60 * 1000);
        await user.save();
        await sendResetLink(user.email, token);
      }
    }
    res.json(generic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

async function sendResetLink(to, token) {
  const link = `${clientBase()}/reset-password?token=${token}`;
  return sendMail({
    to,
    subject: "Reset your MyMedin password",
    text: `We received a request to reset your password.\n\nUse this link within 1 hour:\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>We received a request to reset your password.</p>
           <p>Use this link within 1 hour:</p>
           <p><a href="${link}">${link}</a></p>
           <p>If you didn't request this, you can ignore this email.</p>`,
  });
}

// POST /api/auth/reset-password-otp  -> set a new password with a WhatsApp code
router.post("/reset-password-otp", async (req, res) => {
  try {
    const { identifier, code, password } = req.body;
    const c = String(code || "").replace(/\D/g, "");
    if (!identifier || c.length !== 6 || !password) {
      return res.status(400).json({ message: "Phone number, 6-digit code and new password are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const invalid = { message: "That code is invalid or has expired. Request a new one." };
    const candidates = phoneCandidates(identifier);
    const user = candidates.length ? await User.findOne({ phone: { $in: candidates } }) : null;
    const o = user?.resetOtp;
    if (!o?.hash || !o.expires || o.expires < new Date() || (o.attempts || 0) >= OTP_MAX_ATTEMPTS) {
      return res.status(400).json(invalid);
    }

    const ok = crypto.timingSafeEqual(Buffer.from(otpHash(user._id, c)), Buffer.from(o.hash));
    if (!ok) {
      // Count the miss atomically; burn the code once the limit is hit.
      const attempts = (o.attempts || 0) + 1;
      const set = { "resetOtp.attempts": attempts };
      if (attempts >= OTP_MAX_ATTEMPTS) set["resetOtp.hash"] = null;
      await User.updateOne({ _id: user._id, "resetOtp.hash": o.hash }, { $set: set });
      const left = OTP_MAX_ATTEMPTS - attempts;
      return res.status(400).json({
        message: left > 0
          ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.`
          : "Too many incorrect attempts. Request a new code.",
      });
    }

    user.password = password; // re-hashed by the pre-save hook
    user.resetOtp = { sends: o.sends, windowStart: o.windowStart }; // keep the resend cap
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();
    res.json({ message: "Password updated. You can now sign in." });
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
        .select("clinicName availability slotDuration autoConfirmBookings autoApproveAssociations dayOverrides location")
        .lean(),
      AppointmentType.find({ doctor: doctorId }).sort({ order: 1, createdAt: 1 }).lean(),
    ]);
    if (!owner) return res.status(404).json({ message: "Clinic not found" });
    res.json({
      clinicName: owner.clinicName || "",
      availability: owner.availability || [],
      slotDuration: owner.slotDuration || 15,
      autoConfirmBookings: !!owner.autoConfirmBookings,
      autoApproveAssociations: !!owner.autoApproveAssociations,
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
    // Whether patient bookings skip approval. Deliberately the DOCTOR's call,
    // not an assistant's: it decides whether anyone vets the diary at all.
    if (b.autoConfirmBookings !== undefined) {
      if (req.user.role !== "doctor") {
        return res.status(403).json({
          message: "Only the doctor can change how bookings are approved.",
        });
      }
      owner.autoConfirmBookings = !!b.autoConfirmBookings;
    }
    // Same rule for who may join the clinic's patient list without review.
    if (b.autoApproveAssociations !== undefined) {
      if (req.user.role !== "doctor") {
        return res.status(403).json({
          message: "Only the doctor can change how patient requests are approved.",
        });
      }
      owner.autoApproveAssociations = !!b.autoApproveAssociations;
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
      autoConfirmBookings: !!owner.autoConfirmBookings,
      autoApproveAssociations: !!owner.autoApproveAssociations,
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
