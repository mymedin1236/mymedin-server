import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Association from "../models/Association.js";
import Notification from "../models/Notification.js";
import Review from "../models/Review.js";
import { sendPush } from "../utils/push.js";
import { notifyClinic } from "../utils/notify.js";
import { protect, requireRole, clinicId } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

// Create an in-app notification AND fire a background web push to the recipient
const notify = async (user, type, title, body, data) => {
  const notification = await Notification.create({ user, type, title, body, data });
  sendPush(user, { title, body, url: data?.url || "/" });
  return notification;
};

// Assistants act on behalf of their doctor — resolve the doctor's display name.
const doctorNameFor = async (user) => {
  if (user.role === "assistant") {
    const d = await User.findById(user.doctor).select("name");
    return d?.name || "your doctor";
  }
  return user.name;
};

const recomputeRating = async (doctorId) => {
  const [agg] = await Review.aggregate([
    { $match: { doctor: new mongoose.Types.ObjectId(doctorId) } },
    { $group: { _id: "$doctor", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  await User.findByIdAndUpdate(doctorId, {
    rating: agg ? Math.round(agg.avg * 10) / 10 : 0,
    reviewCount: agg ? agg.count : 0,
  });
};

// POST /api/associations/request { doctorId }  (client) -> send association request
router.post("/request", requireRole("client"), async (req, res) => {
  try {
    const { doctorId } = req.body;
    if (!mongoose.isValidObjectId(doctorId)) {
      return res.status(400).json({ message: "Invalid doctor" });
    }
    const doctor = await User.findOne({ _id: doctorId, role: "doctor" });
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });

    const me = await User.findById(req.user._id);
    if (me.doctor) {
      return res.status(409).json({ message: "You are already associated with a doctor. Disassociate first." });
    }
    const existingPending = await Association.findOne({
      client: me._id,
      status: "pending",
    });
    if (existingPending) {
      return res.status(409).json({ message: "You already have a pending request." });
    }

    const association = await Association.create({
      client: me._id,
      doctor: doctor._id,
      status: "pending",
      initiatedBy: "client",
    });

    await notifyClinic(doctor._id, {
      type: "association_request",
      title: "New patient request",
      body: `${me.name} has requested to associate with your clinic.`,
      url: "/clients",
    });

    res.status(201).json(association);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/associations/requests  (doctor) -> pending requests
router.get("/requests", requireRole("doctor", "assistant"), async (req, res) => {
  const requests = await Association.find({ doctor: clinicId(req.user), status: "pending" })
    .populate("client", "name email phone")
    .sort({ createdAt: -1 });
  res.json(requests);
});

// POST /api/associations/:id/approve  (clinic staff)
router.post("/:id/approve", requireRole("doctor", "assistant"), async (req, res) => {
  try {
    const doctorId = clinicId(req.user);
    const association = await Association.findOne({
      _id: req.params.id,
      doctor: doctorId,
      status: "pending",
    });
    if (!association) return res.status(404).json({ message: "Request not found" });

    association.status = "approved";
    association.respondedAt = new Date();
    await association.save();
    await User.findByIdAndUpdate(association.client, { doctor: doctorId });

    await notify(
      association.client,
      "association_approved",
      "Request approved",
      `Dr. ${await doctorNameFor(req.user)} approved your association request.`,
      { associationId: association._id, doctorId }
    );

    res.json(association);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/associations/:id/reject  (doctor)
router.post("/:id/reject", requireRole("doctor", "assistant"), async (req, res) => {
  try {
    const association = await Association.findOne({
      _id: req.params.id,
      doctor: clinicId(req.user),
      status: "pending",
    });
    if (!association) return res.status(404).json({ message: "Request not found" });

    association.status = "rejected";
    association.respondedAt = new Date();
    await association.save();

    await notify(
      association.client,
      "association_rejected",
      "Request declined",
      `Dr. ${await doctorNameFor(req.user)} declined your association request.`,
      { associationId: association._id }
    );

    res.json(association);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/associations/me  (client) -> current doctor + pending request
router.get("/me", requireRole("client"), async (req, res) => {
  const me = await User.findById(req.user._id).populate(
    "doctor",
    "name clinicName specialization rating reviewCount availability image"
  );
  const pending = await Association.findOne({ client: me._id, status: "pending" }).populate(
    "doctor",
    "name clinicName"
  );
  // The patient's own review of their current doctor (so the home screen shows
  // "your review · edit" instead of re-prompting them to rate every visit).
  let myReview = null;
  if (me.doctor) {
    const r = await Review.findOne({ doctor: me.doctor._id, client: me._id }).select(
      "rating comment updatedAt"
    );
    if (r) myReview = { rating: r.rating, comment: r.comment || "", updatedAt: r.updatedAt };
  }
  res.json({ doctor: me.doctor || null, pending: pending || null, myReview });
});

// POST /api/associations/disassociate { rating, comment }  (client)
router.post("/disassociate", requireRole("client"), async (req, res) => {
  try {
    const me = await User.findById(req.user._id);
    if (!me.doctor) {
      return res.status(409).json({ message: "You are not associated with a doctor." });
    }
    const doctorId = me.doctor;

    // End the active association
    await Association.findOneAndUpdate(
      { client: me._id, doctor: doctorId, status: "approved" },
      { status: "ended", endedAt: new Date() }
    );
    me.doctor = undefined;
    await me.save();

    // Capture rating/review on the way out (optional)
    const { rating, comment } = req.body;
    if (rating) {
      await Review.findOneAndUpdate(
        { doctor: doctorId, client: me._id },
        { rating: Number(rating), comment },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await recomputeRating(doctorId);
    }

    await notify(
      doctorId,
      "association_ended",
      "Patient disassociated",
      `${me.name} has left your clinic.`,
      { clientId: me._id }
    );

    res.json({ message: "Disassociated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
