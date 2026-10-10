import express from "express";
import crypto from "crypto";
import User from "../models/User.js";
import { patientDoctorIds, linkPatient } from "../utils/careTeam.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();
router.use(protect, requireRole("client"));

const PUBLIC = "name dateOfBirth managed guardian createdAt";

// GET /api/family -> the patient's own dependents (children they manage)
router.get("/", async (req, res) => {
  const deps = await User.find({ role: "client", managed: true, guardian: req.user._id })
    .select(PUBLIC)
    .sort({ createdAt: -1 });
  res.json(deps);
});

// POST /api/family { name, dateOfBirth } -> add a dependent linked to me + my clinic
router.post("/", async (req, res) => {
  try {
    const { name, dateOfBirth } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Name is required." });
    // The child joins every doctor the guardian is with, so the guardian can
    // book them with any of them (dentist, physio, eye specialist…).
    const doctorIds = await patientDoctorIds(req.user);
    if (!doctorIds.length) {
      return res.status(400).json({ message: "Associate with a doctor first to add a dependent." });
    }
    const dep = await User.create({
      name: name.trim(),
      role: "client",
      managed: true,
      guardian: req.user._id,
      guardianName: req.user.name,
      guardianPhone: req.user.phone,
      guardianEmail: req.user.email,
      dateOfBirth: dateOfBirth || undefined,
      password: crypto.randomBytes(24).toString("hex"), // no usable login
      doctor: doctorIds[0],
    });
    for (const d of doctorIds) await linkPatient(dep._id, d, "client");
    res.status(201).json(dep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/family/:id -> remove a dependent the patient owns
router.delete("/:id", async (req, res) => {
  const dep = await User.findOneAndDelete({
    _id: req.params.id,
    managed: true,
    guardian: req.user._id,
  });
  if (!dep) return res.status(404).json({ message: "Dependent not found" });
  res.json({ message: "Deleted" });
});

export default router;
