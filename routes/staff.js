import express from "express";
import User from "../models/User.js";
import { sendMail } from "../utils/mailer.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Only the doctor (clinic owner) manages their staff — not assistants themselves.
router.use(protect, requireRole("doctor"));

// GET /api/staff -> assistants belonging to this doctor
router.get("/", async (req, res) => {
  const staff = await User.find({ role: "assistant", doctor: req.user._id })
    .select("name email phone createdAt")
    .sort({ createdAt: -1 });
  res.json(staff);
});

// POST /api/staff -> create an assistant account linked to this doctor
router.post("/", async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !password) {
      return res.status(400).json({ message: "name and password are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const cleanEmail = email?.trim().toLowerCase() || undefined;
    const trimmedPhone = phone?.trim() || undefined;
    if (!cleanEmail && !trimmedPhone) {
      return res.status(400).json({ message: "Provide an email or phone so the assistant can sign in." });
    }
    if (cleanEmail) {
      const exists = await User.findOne({ email: cleanEmail });
      if (exists) return res.status(409).json({ message: "Email already in use" });
    }
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }

    const assistant = await User.create({
      name,
      email: cleanEmail,
      password,
      role: "assistant",
      phone: trimmedPhone,
      doctor: req.user._id,
    });

    const loginUrl =
      (process.env.CLIENT_ORIGIN || "http://localhost:5173")
        .split(",")[0]
        .trim()
        .replace(/\/+$/, "") + "/login";
    const shareMessage =
      `Hi ${name}, Dr. ${req.user.name} added you as an assistant on MyMedin.\n\n` +
      `Login: ${loginUrl}\n` +
      (cleanEmail ? `Email: ${cleanEmail}\n` : `Phone: ${trimmedPhone}\n`) +
      `Password: ${password}\n\n` +
      `Please sign in and change your password.`;

    if (cleanEmail) {
      sendMail({
        to: cleanEmail,
        subject: "Your MyMedin assistant account",
        text: shareMessage,
        html: shareMessage.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("staff creds email failed:", e?.message));
    }

    res.status(201).json({
      assistant: { _id: assistant._id, name: assistant.name, email: cleanEmail || "", phone: trimmedPhone || "" },
      credentials: { email: cleanEmail || "", phone: trimmedPhone || "", password },
      shareMessage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/staff/:id -> update an assistant's name/phone (and optionally reset password)
router.put("/:id", async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const trimmedPhone = phone?.trim();
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone, _id: { $ne: req.params.id } });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }

    const assistant = await User.findOne({
      _id: req.params.id,
      role: "assistant",
      doctor: req.user._id,
    });
    if (!assistant) return res.status(404).json({ message: "Assistant not found" });

    if (name !== undefined) assistant.name = name;
    assistant.phone = trimmedPhone || undefined;
    if (password) {
      if (String(password).length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      assistant.password = password; // hashed by the User pre-save hook
    }
    await assistant.save();
    res.json({ _id: assistant._id, name: assistant.name, email: assistant.email || "", phone: assistant.phone || "" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/staff/:id
router.delete("/:id", async (req, res) => {
  const assistant = await User.findOneAndDelete({
    _id: req.params.id,
    role: "assistant",
    doctor: req.user._id,
  });
  if (!assistant) return res.status(404).json({ message: "Assistant not found" });
  res.json({ message: "Deleted" });
});

export default router;
