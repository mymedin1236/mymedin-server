import express from "express";
import mongoose from "mongoose";
import AppointmentType from "../models/AppointmentType.js";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { protect, resolveClinic, requireStaff, clinicId } from "../middleware/auth.js";

const router = express.Router();
router.use(protect, requireStaff, resolveClinic);

// Fields the client is allowed to set, validated and coerced.
const sanitize = (b) => {
  const out = {};
  if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 60);
  if (b.duration !== undefined) {
    const d = Number(b.duration);
    if (!Number.isFinite(d) || d < 5 || d > 480) return { error: "Duration must be between 5 and 480 minutes." };
    out.duration = Math.round(d);
  }
  if (b.color !== undefined) out.color = /^#[0-9a-fA-F]{3,8}$/.test(b.color || "") ? b.color : "";
  if (b.description !== undefined) out.description = String(b.description).trim().slice(0, 200);
  if (b.active !== undefined) out.active = !!b.active;
  if (b.order !== undefined && Number.isFinite(Number(b.order))) out.order = Number(b.order);
  return out;
};

// GET /api/appointment-types  -> the clinic's types (active first, in order).
// ?all=1 includes retired ones (the settings editor asks for these).
router.get("/", async (req, res) => {
  try {
    const filter = { doctor: clinicId(req.user) };
    if (req.query.all !== "1") filter.active = true;
    const types = await AppointmentType.find(filter).sort({ order: 1, createdAt: 1 }).lean();
    res.json({ types });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/appointment-types  -> create one.
router.post("/", async (req, res) => {
  try {
    const fields = sanitize(req.body);
    if (fields.error) return res.status(400).json({ message: fields.error });
    if (!fields.name) return res.status(400).json({ message: "Please give this appointment type a name." });
    if (!fields.duration) return res.status(400).json({ message: "Please set how long this appointment takes." });

    const doctor = clinicId(req.user);
    const count = await AppointmentType.countDocuments({ doctor });
    const type = await AppointmentType.create({ ...fields, doctor, order: fields.order ?? count });
    res.status(201).json({ type });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "You already have an appointment type with that name." });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/appointment-types/:id  -> rename / re-time / recolour one.
//
// Changing a duration only affects FUTURE bookings: appointments already booked
// keep the duration they were created with (snapshotted on the appointment), so
// nobody's confirmed 90-minute session silently shrinks to 40.
router.put("/:id", async (req, res) => {
  try {
    const fields = sanitize(req.body);
    if (fields.error) return res.status(400).json({ message: fields.error });
    const type = await AppointmentType.findOneAndUpdate(
      { _id: req.params.id, doctor: clinicId(req.user) },
      { $set: fields },
      { new: true, runValidators: true }
    );
    if (!type) return res.status(404).json({ message: "Appointment type not found" });
    res.json({ type });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "You already have an appointment type with that name." });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/appointment-types/:id
//
// A type that is in use — by upcoming appointments or by any operational-hours
// bracket — is RETIRED (active: false) instead of deleted, so historic bookings
// keep their label and nobody's calendar loses hours. Only a genuinely unused
// type is removed outright. `?force=1` retires in either case.
router.delete("/:id", async (req, res) => {
  try {
    const doctor = clinicId(req.user);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Appointment type not found" });
    }
    const type = await AppointmentType.findOne({ _id: req.params.id, doctor });
    if (!type) return res.status(404).json({ message: "Appointment type not found" });

    const [usedByAppt, owner] = await Promise.all([
      Appointment.exists({ doctor, appointmentType: type._id }),
      User.findById(doctor).select("availability dayOverrides").lean(),
    ]);
    const inHours =
      (owner?.availability || []).some((a) => String(a.appointmentType || "") === String(type._id)) ||
      (owner?.dayOverrides || []).some((o) =>
        (o.blocks || []).some((b) => String(b.appointmentType || "") === String(type._id))
      );

    if (usedByAppt || inHours || req.query.force === "1") {
      type.active = false;
      await type.save();
      return res.json({
        type,
        retired: true,
        message: "This type is in use, so it was retired instead of deleted. Existing appointments keep their label.",
      });
    }

    await type.deleteOne();
    res.json({ message: "Deleted", retired: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
