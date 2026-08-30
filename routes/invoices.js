import express from "express";
import Invoice from "../models/Invoice.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// The clinic's own subscription invoices. Owner (dentist) only — assistants
// never see billing, same as Finances/Expenses.
router.use(protect, requireRole("dentist"));

router.get("/", async (req, res) => {
  try {
    const invoices = await Invoice.find({ dentist: req.user._id })
      .select("month amount currency issueDate dueDate status paidAt note")
      .sort({ month: -1 });
    res.json(invoices);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
