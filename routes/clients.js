import express from "express";
import crypto from "crypto";
import User from "../models/User.js";
import Association from "../models/Association.js";
import { sendMail } from "../utils/mailer.js";
import { protect, requireRole, resolveClinic, clinicId } from "../middleware/auth.js";

const router = express.Router();

// Resolve the owning doctor's display name (assistants act on behalf of the doctor).
const doctorNameFor = async (reqUser, doctorId) =>
  (reqUser.role === "assistant"
    ? (await User.findById(doctorId).select("name"))?.name
    : reqUser.name) || reqUser.name;

// All routes here require authenticated clinic staff (doctor or their assistant)
router.use(protect, requireRole("doctor", "assistant"), resolveClinic);

// GET /api/clients  -> list clients associated with THIS clinic
router.get("/", async (req, res) => {
  const { search, managed } = req.query;
  const filter = { role: "client", doctor: clinicId(req.user) };
  // Split adult patients vs managed dependents (children) when requested.
  if (managed === "true") filter.managed = true;
  else if (managed === "false") filter.managed = { $ne: true };
  if (search) {
    filter.$or = [
      { name: new RegExp(search, "i") },
      { email: new RegExp(search, "i") },
      { phone: new RegExp(search, "i") },
      { guardianName: new RegExp(search, "i") },
      { guardianPhone: new RegExp(search, "i") },
    ];
  }
  const clients = await User.find(filter).sort({ createdAt: -1 });
  res.json(clients);
});

// POST /api/clients -> create a new client record (doctor creating on behalf of client)
router.post("/", async (req, res) => {
  try {
    const { name, email, password, phone, dateOfBirth } = req.body;
    const owningDoctorId = clinicId(req.user);

    // --- Managed (dependent) patient: a child with no own login; contact the guardian. ---
    if (req.body.managed) {
      const gName = req.body.guardianName?.trim();
      const gPhone = req.body.guardianPhone?.trim();
      const gEmail = req.body.guardianEmail?.trim().toLowerCase() || undefined;
      if (!name?.trim()) return res.status(400).json({ message: "Patient name is required" });
      if (!gName) return res.status(400).json({ message: "Guardian name is required" });
      if (!/^\d{11}$/.test(gPhone || "")) {
        return res.status(400).json({ message: "Guardian phone must be exactly 11 digits." });
      }

      const child = await User.create({
        name: name.trim(),
        role: "client",
        managed: true,
        guardianName: gName,
        guardianPhone: gPhone,
        guardianEmail: gEmail,
        dateOfBirth,
        password: crypto.randomBytes(24).toString("hex"), // random → no usable login
        doctor: owningDoctorId,
      });
      await Association.create({
        client: child._id,
        doctor: owningDoctorId,
        status: "approved",
        initiatedBy: "doctor",
        respondedAt: new Date(),
      });

      const dName = await doctorNameFor(req.user, owningDoctorId);
      const shareMessage =
        `Hi ${gName}, Dr. ${dName} added ${name.trim()} as a patient at the clinic. ` +
        `We'll reach you on this number/email about ${name.trim()}'s appointments and reminders.`;
      if (gEmail) {
        sendMail({
          to: gEmail,
          subject: `${name.trim()} — added at MyMedin`,
          text: shareMessage,
          html: shareMessage.replace(/\n/g, "<br/>"),
        }).catch((e) => console.error("guardian email failed:", e?.message));
      }

      return res.status(201).json({
        client: child,
        managed: true,
        credentials: { email: gEmail || "", phone: gPhone, password: "" },
        shareMessage,
      });
    }

    if (!name || !password) {
      return res.status(400).json({ message: "name and password are required" });
    }
    const cleanEmail = email?.trim().toLowerCase() || undefined;
    const trimmedPhone = phone?.trim() || undefined;
    if (!cleanEmail && !trimmedPhone) {
      return res.status(400).json({ message: "Provide an email or phone so the patient can sign in." });
    }
    if (cleanEmail) {
      const exists = await User.findOne({ email: cleanEmail });
      if (exists) return res.status(409).json({ message: "Email already in use" });
    }
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }

    const client = await User.create({
      name,
      email: cleanEmail,
      password,
      role: "client",
      phone: trimmedPhone,
      dateOfBirth,
      doctor: owningDoctorId,
    });

    // Record the (already-approved) association created by the clinic
    await Association.create({
      client: client._id,
      doctor: owningDoctorId,
      status: "approved",
      initiatedBy: "doctor",
      respondedAt: new Date(),
    });

    // The credentials message should name the doctor, even if an assistant created the account.
    const owner =
      req.user.role === "assistant"
        ? await User.findById(owningDoctorId).select("name")
        : req.user;
    const doctorName = owner?.name || req.user.name;

    // Build shareable login credentials and email them to the client
    const loginUrl =
      (process.env.CLIENT_ORIGIN || "http://localhost:5173")
        .split(",")[0]
        .trim()
        .replace(/\/+$/, "") + "/login";
    const shareMessage =
      `Hi ${name}, Dr. ${doctorName} created your MyMedin account.\n\n` +
      `Login: ${loginUrl}\n` +
      (cleanEmail ? `Email: ${cleanEmail}\n` : `Phone: ${trimmedPhone}\n`) +
      `Password: ${password}\n\n` +
      `Please sign in and change your password.`;

    // Email the credentials only when we have an email address to send to.
    if (cleanEmail) {
      sendMail({
        to: cleanEmail,
        subject: "Your MyMedin account",
        text: shareMessage,
        html: shareMessage.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("creds email failed:", e?.message));
    }

    // Return the client plus credentials so the doctor can copy / share via WhatsApp
    res.status(201).json({
      client,
      credentials: { email: cleanEmail || "", phone: trimmedPhone || "", password },
      shareMessage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/clients/:id
router.get("/:id", async (req, res) => {
  const client = await User.findOne({
    _id: req.params.id,
    role: "client",
    doctor: clinicId(req.user),
  });
  if (!client) return res.status(404).json({ message: "Client not found" });
  res.json(client);
});

// PUT /api/clients/:id
router.put("/:id", async (req, res) => {
  try {
    const { name, phone, dateOfBirth, address, medicalNotes } = req.body;
    const existing = await User.findOne({
      _id: req.params.id,
      role: "client",
      doctor: clinicId(req.user),
    });
    if (!existing) return res.status(404).json({ message: "Client not found" });

    // Managed (child) patient: edit name/DOB + guardian contact, no own phone/login.
    if (existing.managed) {
      const gName = req.body.guardianName?.trim();
      const gPhone = req.body.guardianPhone?.trim();
      if (gPhone && !/^\d{11}$/.test(gPhone)) {
        return res.status(400).json({ message: "Guardian phone must be exactly 11 digits." });
      }
      if (name !== undefined) existing.name = name;
      if (dateOfBirth !== undefined) existing.dateOfBirth = dateOfBirth || undefined;
      if (gName !== undefined) existing.guardianName = gName;
      if (gPhone !== undefined) existing.guardianPhone = gPhone;
      if (req.body.guardianEmail !== undefined)
        existing.guardianEmail = req.body.guardianEmail?.trim().toLowerCase() || undefined;
      await existing.save();
      return res.json(existing);
    }

    const trimmedPhone = phone?.trim();
    if (trimmedPhone) {
      const phoneExists = await User.findOne({
        phone: trimmedPhone,
        _id: { $ne: req.params.id },
      });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }

    // findOneAndUpdate bypasses the save hook, so clear empty phones explicitly
    const update = { name, dateOfBirth, address, medicalNotes };
    const ops = trimmedPhone
      ? { $set: { ...update, phone: trimmedPhone } }
      : { $set: update, $unset: { phone: "" } };

    const client = await User.findOneAndUpdate(
      { _id: req.params.id, role: "client", doctor: clinicId(req.user) },
      ops,
      { new: true }
    );
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(client);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/clients/:id/reset-password  (staff sets a new temporary password for their patient)
router.post("/:id/reset-password", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const client = await User.findOne({
      _id: req.params.id,
      role: "client",
      doctor: clinicId(req.user),
    });
    if (!client) return res.status(404).json({ message: "Patient not found" });

    client.password = password; // hashed by the User pre-save hook
    await client.save();

    const loginUrl =
      (process.env.CLIENT_ORIGIN || "http://localhost:5173")
        .split(",")[0]
        .trim()
        .replace(/\/+$/, "") + "/login";
    const shareMessage =
      `Hi ${client.name}, your MyMedin password has been reset.\n\n` +
      `Login: ${loginUrl}\n` +
      (client.email ? `Email: ${client.email}\n` : client.phone ? `Phone: ${client.phone}\n` : "") +
      `Password: ${password}\n\n` +
      `Please sign in and change your password.`;

    res.json({
      credentials: { email: client.email || "", phone: client.phone || "", password },
      shareMessage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/clients/:id
router.delete("/:id", async (req, res) => {
  const client = await User.findOneAndDelete({
    _id: req.params.id,
    role: "client",
    doctor: clinicId(req.user),
  });
  if (!client) return res.status(404).json({ message: "Client not found" });
  res.json({ message: "Deleted" });
});

export default router;
