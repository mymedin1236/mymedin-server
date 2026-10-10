import express from "express";
import crypto from "crypto";
import User from "../models/User.js";
import Association from "../models/Association.js";
import { sendMail } from "../utils/mailer.js";
import { sendWhatsApp } from "../utils/whatsapp.js";
import { protect, requireRole, resolveClinic, clinicId } from "../middleware/auth.js";
import {
  clinicPatientIds,
  findClinicPatient,
  isClinicPatient,
  linkPatient,
  unlinkPatient,
  patientDoctorIds,
  withClinicNotes,
  withClinicNotesMany,
  setClinicNotes,
  findExistingByContact,
  existingPatientConflict,
  announceLink,
  createClinicPatient,
} from "../utils/careTeam.js";

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
  const filter = { role: "client", _id: { $in: await clinicPatientIds(clinicId(req.user)) } };
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
  res.json(await withClinicNotesMany(clinicId(req.user), clients));
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
      // A guardian usually has a phone but no email, so WhatsApp is the only
      // channel that actually reaches most of them.
      if (gPhone) {
        sendWhatsApp({ to: gPhone, text: shareMessage }).catch((e) =>
          console.error("guardian whatsapp failed:", e?.message)
        );
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
    // The person may already be a patient elsewhere (a dentist adding someone
    // the eye clinic already registered). Don't make a second account — tell
    // staff who it is so they can add that patient to this clinic instead.
    const existing = await findExistingByContact(cleanEmail, trimmedPhone);
    if (existing) return res.status(409).json(await existingPatientConflict(existing, owningDoctorId));

    const { client, credentials, shareMessage } = await createClinicPatient(owningDoctorId, {
      name,
      email: cleanEmail,
      phone: trimmedPhone,
      password,
      dateOfBirth,
    });

    // Return the client plus credentials so the doctor can copy / share via WhatsApp
    res.status(201).json({ client, credentials, shareMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/clients/:id/link -> add a patient who is already registered with
// another doctor to THIS clinic too. Their account, login and other doctors are
// untouched; the patient is told which clinic added them.
router.post("/:id/link", async (req, res) => {
  try {
    const doctorId = clinicId(req.user);
    const client = await User.findOne({ _id: req.params.id, role: "client" });
    if (!client) return res.status(404).json({ message: "Patient not found" });
    if (await isClinicPatient(doctorId, client._id)) {
      return res.json({ client: await withClinicNotes(doctorId, client), alreadyLinked: true });
    }
    await linkPatient(client._id, doctorId, "doctor");
    await announceLink(doctorId, client);
    const fresh = await User.findById(client._id);
    res.status(201).json({ client: await withClinicNotes(doctorId, fresh) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/clients/:id
router.get("/:id", async (req, res) => {
  const doctorId = clinicId(req.user);
  const client = await findClinicPatient(doctorId, req.params.id);
  if (!client) return res.status(404).json({ message: "Client not found" });
  res.json(await withClinicNotes(doctorId, client));
});

// PUT /api/clients/:id
router.put("/:id", async (req, res) => {
  try {
    const { name, phone, dateOfBirth, address, medicalNotes } = req.body;
    const doctorId = clinicId(req.user);
    const existing = await findClinicPatient(doctorId, req.params.id);
    if (!existing) return res.status(404).json({ message: "Client not found" });

    // Notes are private to this clinic, so they go on its association, never
    // on the User record the patient's other doctors share.
    if (medicalNotes !== undefined) await setClinicNotes(doctorId, existing, medicalNotes);

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
      return res.json(await withClinicNotes(doctorId, existing));
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
    const update = { name, dateOfBirth, address };
    const ops = trimmedPhone
      ? { $set: { ...update, phone: trimmedPhone } }
      : { $set: update, $unset: { phone: "" } };

    const client = await User.findOneAndUpdate({ _id: existing._id, role: "client" }, ops, { new: true });
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(await withClinicNotes(doctorId, client));
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
    const doctorId = clinicId(req.user);
    const client = await findClinicPatient(doctorId, req.params.id);
    if (!client) return res.status(404).json({ message: "Patient not found" });
    // The login belongs to the patient, not to any one clinic. Once they're with
    // other doctors too, one clinic must not be able to take over the account.
    const doctors = await patientDoctorIds(client);
    if (doctors.some((d) => d !== String(doctorId))) {
      return res.status(403).json({
        message:
          "This patient is also with other doctors, so only they can change their password (via Forgot password).",
        code: "SHARED_PATIENT",
      });
    }

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

    // Previously this reached the patient on no channel at all — the reset
    // password was only handed back to staff to pass on manually.
    if (client.email) {
      sendMail({
        to: client.email,
        subject: "Your MyMedin password was reset",
        text: shareMessage,
        html: shareMessage.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("reset email failed:", e?.message));
    }
    if (client.phone) {
      sendWhatsApp({ to: client.phone, text: shareMessage }).catch((e) =>
        console.error("reset whatsapp failed:", e?.message)
      );
    }

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
// Removes the patient from THIS clinic. The account itself is deleted only when
// no other doctor still has them; otherwise their other clinics keep them.
router.delete("/:id", async (req, res) => {
  try {
    const doctorId = clinicId(req.user);
    const client = await findClinicPatient(doctorId, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const stillWithOthers = await unlinkPatient(client._id, doctorId);
    if (stillWithOthers) return res.json({ message: "Removed from this clinic", removed: true });
    await User.deleteOne({ _id: client._id, role: "client" });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
