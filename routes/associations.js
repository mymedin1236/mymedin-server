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

// Assistants act on behalf of their dentist — resolve the dentist's display name.
const dentistNameFor = async (user) => {
  if (user.role === "assistant") {
    const d = await User.findById(user.dentist).select("name");
    return d?.name || "your dentist";
  }
  return user.name;
};

const recomputeRating = async (dentistId) => {
  const [agg] = await Review.aggregate([
    { $match: { dentist: new mongoose.Types.ObjectId(dentistId) } },
    { $group: { _id: "$dentist", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  await User.findByIdAndUpdate(dentistId, {
    rating: agg ? Math.round(agg.avg * 10) / 10 : 0,
    reviewCount: agg ? agg.count : 0,
  });
};

// POST /api/associations/request { dentistId }  (client) -> send association request
router.post("/request", requireRole("client"), async (req, res) => {
  try {
    const { dentistId } = req.body;
    if (!mongoose.isValidObjectId(dentistId)) {
      return res.status(400).json({ message: "Invalid dentist" });
    }
    const dentist = await User.findOne({ _id: dentistId, role: "dentist" });
    if (!dentist) return res.status(404).json({ message: "Dentist not found" });

    const me = await User.findById(req.user._id);
    if (me.dentist) {
      return res.status(409).json({ message: "You are already associated with a dentist. Disassociate first." });
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
      dentist: dentist._id,
      status: "pending",
      initiatedBy: "client",
    });

    await notifyClinic(dentist._id, {
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

// GET /api/associations/requests  (dentist) -> pending requests
router.get("/requests", requireRole("dentist", "assistant"), async (req, res) => {
  const requests = await Association.find({ dentist: clinicId(req.user), status: "pending" })
    .populate("client", "name email phone")
    .sort({ createdAt: -1 });
  res.json(requests);
});

// POST /api/associations/:id/approve  (clinic staff)
router.post("/:id/approve", requireRole("dentist", "assistant"), async (req, res) => {
  try {
    const dentistId = clinicId(req.user);
    const association = await Association.findOne({
      _id: req.params.id,
      dentist: dentistId,
      status: "pending",
    });
    if (!association) return res.status(404).json({ message: "Request not found" });

    association.status = "approved";
    association.respondedAt = new Date();
    await association.save();
    await User.findByIdAndUpdate(association.client, { dentist: dentistId });

    await notify(
      association.client,
      "association_approved",
      "Request approved",
      `Dr. ${await dentistNameFor(req.user)} approved your association request.`,
      { associationId: association._id, dentistId }
    );

    res.json(association);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/associations/:id/reject  (dentist)
router.post("/:id/reject", requireRole("dentist", "assistant"), async (req, res) => {
  try {
    const association = await Association.findOne({
      _id: req.params.id,
      dentist: clinicId(req.user),
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
      `Dr. ${await dentistNameFor(req.user)} declined your association request.`,
      { associationId: association._id }
    );

    res.json(association);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/associations/me  (client) -> current dentist + pending request
router.get("/me", requireRole("client"), async (req, res) => {
  const me = await User.findById(req.user._id).populate(
    "dentist",
    "name clinicName specialization rating reviewCount availability image"
  );
  const pending = await Association.findOne({ client: me._id, status: "pending" }).populate(
    "dentist",
    "name clinicName"
  );
  // The patient's own review of their current dentist (so the home screen shows
  // "your review · edit" instead of re-prompting them to rate every visit).
  let myReview = null;
  if (me.dentist) {
    const r = await Review.findOne({ dentist: me.dentist._id, client: me._id }).select(
      "rating comment updatedAt"
    );
    if (r) myReview = { rating: r.rating, comment: r.comment || "", updatedAt: r.updatedAt };
  }
  res.json({ dentist: me.dentist || null, pending: pending || null, myReview });
});

// POST /api/associations/disassociate { rating, comment }  (client)
router.post("/disassociate", requireRole("client"), async (req, res) => {
  try {
    const me = await User.findById(req.user._id);
    if (!me.dentist) {
      return res.status(409).json({ message: "You are not associated with a dentist." });
    }
    const dentistId = me.dentist;

    // End the active association
    await Association.findOneAndUpdate(
      { client: me._id, dentist: dentistId, status: "approved" },
      { status: "ended", endedAt: new Date() }
    );
    me.dentist = undefined;
    await me.save();

    // Capture rating/review on the way out (optional)
    const { rating, comment } = req.body;
    if (rating) {
      await Review.findOneAndUpdate(
        { dentist: dentistId, client: me._id },
        { rating: Number(rating), comment },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await recomputeRating(dentistId);
    }

    await notify(
      dentistId,
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
