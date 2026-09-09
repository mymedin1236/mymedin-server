import express from "express";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";
import { notifyUser } from "../utils/notify.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Only the doctor (clinic owner) manages who's engaged with their clinic — an
// assistant owns their own account and responds to invites via routes/engagements.js.
router.use(protect, requireRole("doctor"));

// GET /api/staff -> assistants actively engaged with this doctor's clinic
router.get("/", async (req, res) => {
  const engagements = await Engagement.find({ doctor: req.user._id, status: "active" })
    .populate("assistant", "name email phone")
    .sort({ startedAt: -1 });
  res.json(
    engagements.map((e) => ({
      engagementId: e._id,
      _id: e.assistant._id,
      name: e.assistant.name,
      email: e.assistant.email || "",
      phone: e.assistant.phone || "",
      startedAt: e.startedAt,
    }))
  );
});

// GET /api/staff/pending -> invites this doctor sent that haven't been answered yet
router.get("/pending", async (req, res) => {
  const pending = await Engagement.find({ doctor: req.user._id, status: "pending", initiatedBy: "doctor" })
    .populate("assistant", "name email phone")
    .sort({ createdAt: -1 });
  res.json(pending);
});

// POST /api/staff/invite { identifier } -> invite an existing assistant account
// by email or phone. The assistant now owns their own login (self-registered),
// so a doctor can no longer create an account or set its password — they can
// only ask an existing assistant to join their clinic.
router.post("/invite", async (req, res) => {
  try {
    const identifier = req.body.identifier?.trim();
    if (!identifier) {
      return res.status(400).json({ message: "Enter the assistant's email or phone." });
    }
    const query = identifier.includes("@")
      ? { email: identifier.toLowerCase() }
      : { phone: identifier };
    const assistant = await User.findOne({ ...query, role: "assistant" });
    if (!assistant) {
      return res.status(404).json({
        message: "No assistant account found with that email/phone. Ask them to sign up on MyMedin first, then invite them.",
      });
    }

    const existing = await Engagement.findOne({
      assistant: assistant._id,
      doctor: req.user._id,
      status: { $in: ["pending", "active"] },
    });
    if (existing) {
      return res.status(409).json({
        message: existing.status === "active" ? "Already part of your clinic." : "Invite already sent.",
      });
    }

    const engagement = await Engagement.create({
      assistant: assistant._id,
      doctor: req.user._id,
      status: "pending",
      initiatedBy: "doctor",
    });

    await notifyUser(assistant._id, {
      type: "engagement_invite",
      title: "Clinic invite",
      body: `Dr. ${req.user.name} invited you to join their clinic on MyMedin.`,
      url: "/my-clinics",
    });

    res.status(201).json({ engagement, assistant: { name: assistant.name, email: assistant.email || "", phone: assistant.phone || "" } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/staff/:id -> end the engagement with this assistant (":id" is the
// assistant's user id, matching the old route shape). Never deletes the
// assistant's account — it's theirs, and may still be active with other clinics.
router.delete("/:id", async (req, res) => {
  const engagement = await Engagement.findOneAndUpdate(
    { assistant: req.params.id, doctor: req.user._id, status: "active" },
    { status: "ended", endedAt: new Date() },
    { new: true }
  );
  if (!engagement) return res.status(404).json({ message: "Not an active member of your clinic" });

  await notifyUser(engagement.assistant, {
    type: "engagement_ended",
    title: "Removed from clinic",
    body: `Dr. ${req.user.name} has ended your engagement with their clinic.`,
    url: "/my-clinics",
  });

  res.json({ message: "Ended" });
});

// DELETE /api/staff/invite/:engagementId -> cancel a pending invite this doctor sent
router.delete("/invite/:engagementId", async (req, res) => {
  const cancelled = await Engagement.findOneAndDelete({
    _id: req.params.engagementId,
    doctor: req.user._id,
    status: "pending",
    initiatedBy: "doctor",
  });
  if (!cancelled) return res.status(404).json({ message: "Invite not found" });
  res.json({ message: "Cancelled" });
});

export default router;
