import express from "express";
import crypto from "crypto";
import User from "../models/User.js";
import Association from "../models/Association.js";
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
    if (!req.user.doctor) {
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
      doctor: req.user.doctor,
    });
    await Association.create({
      client: dep._id,
      doctor: req.user.doctor,
      status: "approved",
      initiatedBy: "client",
      respondedAt: new Date(),
    });
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
