import express from "express";
import Engagement from "../models/Engagement.js";
import { notifyUser } from "../utils/notify.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Every route here is the assistant managing their own clinic relationships —
// no clinic-scoping needed, these operate on the assistant's own identity.
router.use(protect, requireRole("assistant"));

// GET /api/engagements -> this assistant's pending + active clinics
router.get("/", async (req, res) => {
  const engagements = await Engagement.find({
    assistant: req.user._id,
    status: { $in: ["pending", "active"] },
  })
    .populate("doctor", "name clinicName")
    .sort({ createdAt: -1 });
  res.json(engagements);
});

// POST /api/engagements/:id/accept -> accept a doctor-initiated invite
router.post("/:id/accept", async (req, res) => {
  const engagement = await Engagement.findOne({
    _id: req.params.id,
    assistant: req.user._id,
    status: "pending",
  });
  if (!engagement) return res.status(404).json({ message: "Invite not found" });

  engagement.status = "active";
  engagement.startedAt = new Date();
  await engagement.save();

  await notifyUser(engagement.doctor, {
    type: "engagement_accepted",
    title: "Invite accepted",
    body: `${req.user.name} has joined your clinic as an assistant.`,
    url: "/staff",
  });

  res.json(engagement);
});

// POST /api/engagements/:id/decline
router.post("/:id/decline", async (req, res) => {
  const engagement = await Engagement.findOneAndDelete({
    _id: req.params.id,
    assistant: req.user._id,
    status: "pending",
  });
  if (!engagement) return res.status(404).json({ message: "Invite not found" });
  res.json({ message: "Declined" });
});

// POST /api/engagements/:id/end -> the assistant leaves a clinic themselves
router.post("/:id/end", async (req, res) => {
  const engagement = await Engagement.findOneAndUpdate(
    { _id: req.params.id, assistant: req.user._id, status: "active" },
    { status: "ended", endedAt: new Date() },
    { new: true }
  );
  if (!engagement) return res.status(404).json({ message: "Not an active engagement" });

  await notifyUser(engagement.doctor, {
    type: "engagement_left",
    title: "Assistant left",
    body: `${req.user.name} has left your clinic.`,
    url: "/staff",
  });

  res.json({ message: "Left clinic" });
});

export default router;
