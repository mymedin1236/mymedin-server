import mongoose from "mongoose";

// Maintenance / operational expenses recorded by a doctor
// (machine servicing, equipment repair, consumables, utilities, etc.)
const expenseSchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, trim: true, default: "Other" },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

export default mongoose.model("Expense", expenseSchema);
