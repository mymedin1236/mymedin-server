import express from "express";
import Notification from "../models/Notification.js";
import Appointment from "../models/Appointment.js";
import { protect } from "../middleware/auth.js";
import { notifyClinic } from "../utils/notify.js";

const router = express.Router();
router.use(protect);

const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    timeZone: "Asia/Karachi",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

// GET /api/notifications?limit=50 -> notifications + unread count + total.
// `limit` lets the client page back through older notifications ("Load older").
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const [items, unreadCount, total] = await Promise.all([
      Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(limit),
      Notification.countDocuments({ user: req.user._id, read: false }),
      Notification.countDocuments({ user: req.user._id }),
    ]);
    res.json({ items, unreadCount, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/notifications/read-all -> mark all as read
router.post("/read-all", async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ message: "ok" });
});

// POST /api/notifications/:id/read -> mark one as read
router.post("/:id/read", async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { read: true }
  );
  res.json({ message: "ok" });
});

// POST /api/notifications/:id/unread -> mark one as unread
router.post("/:id/unread", async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { read: false }
  );
  res.json({ message: "ok" });
});

// DELETE /api/notifications -> clear all of the user's notifications
router.delete("/", async (req, res) => {
  await Notification.deleteMany({ user: req.user._id });
  res.json({ message: "cleared" });
});

// POST /api/notifications/:id/acknowledge
// The patient acknowledges an appointment notification ("I've seen it"), which
// notifies the clinic (dentist + assistants). Idempotent.
router.post("/:id/acknowledge", async (req, res) => {
  try {
    const n = await Notification.findOne({ _id: req.params.id, user: req.user._id });
    if (!n) return res.status(404).json({ message: "Notification not found" });
    if (!n.data?.canAcknowledge) {
      return res.status(400).json({ message: "This notification can't be acknowledged." });
    }
    if (n.data?.acknowledged) return res.json(n); // already done — idempotent

    n.data = { ...n.data, acknowledged: true, acknowledgedAt: new Date() };
    n.markModified("data");
    n.read = true;
    await n.save();

    // Tell the clinic the patient has seen their appointment schedule.
    const appt = n.data.appointmentId
      ? await Appointment.findById(n.data.appointmentId).populate("client", "name")
      : null;
    if (appt) {
      const patientName = appt.client?.name || req.user.name || "The patient";
      await notifyClinic(appt.dentist, {
        type: "appointment_acknowledged",
        title: "Appointment acknowledged",
        body: `${patientName} has seen their appointment scheduled for ${fmtWhen(appt.date)}.`,
        url: "/appointments",
      });
    }
    res.json(n);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/notifications/:id -> dismiss one
router.delete("/:id", async (req, res) => {
  await Notification.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  res.json({ message: "deleted" });
});

export default router;
