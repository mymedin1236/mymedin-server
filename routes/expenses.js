import express from "express";
import mongoose from "mongoose";
import Expense from "../models/Expense.js";
import { protect, requireRole, clinicId } from "../middleware/auth.js";

const router = express.Router();

// Expenses expose clinic spending — dentist-only, hidden from assistants.
router.use(protect, requireRole("dentist"));

// GET /api/expenses -> dentist's maintenance expenses (newest first)
router.get("/", async (req, res) => {
  try {
    const expenses = await Expense.find({ dentist: clinicId(req.user) }).sort({ date: -1 });
    res.json(expenses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/expenses -> record a maintenance expense
router.post("/", async (req, res) => {
  try {
    const { title, category, amount, date, notes } = req.body;
    if (!title || amount == null) {
      return res.status(400).json({ message: "title and amount are required" });
    }
    if (Number(amount) < 0) {
      return res.status(400).json({ message: "amount cannot be negative" });
    }
    const expense = await Expense.create({
      dentist: clinicId(req.user),
      title,
      category,
      amount: Number(amount),
      date,
      notes,
    });
    res.status(201).json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/expenses/:id -> update an existing expense
router.put("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Expense not found" });
    }
    const { title, category, amount, date, notes } = req.body;
    if (!title || amount == null) {
      return res.status(400).json({ message: "title and amount are required" });
    }
    if (Number(amount) < 0) {
      return res.status(400).json({ message: "amount cannot be negative" });
    }
    const expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, dentist: clinicId(req.user) },
      { title, category, amount: Number(amount), date, notes },
      { new: true }
    );
    if (!expense) return res.status(404).json({ message: "Expense not found" });
    res.json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/expenses/:id
router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Expense not found" });
  }
  const expense = await Expense.findOneAndDelete({
    _id: req.params.id,
    dentist: clinicId(req.user),
  });
  if (!expense) return res.status(404).json({ message: "Expense not found" });
  res.json({ message: "Deleted" });
});

export default router;
