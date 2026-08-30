import mongoose from "mongoose";

// One monthly subscription invoice for a clinic (doctor). Generated on the 5th
// of each billing month, due on the 15th. Admin marks it paid once the doctor
// settles; the doctor sees the status in their Invoices tab.
const invoiceSchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    month: { type: String, required: true }, // billing month, "YYYY-MM" (e.g. "2026-08")
    amount: { type: Number, required: true },
    currency: { type: String, default: "PKR" },
    issueDate: { type: Date, required: true }, // 5th of the month
    dueDate: { type: Date, required: true }, // 15th of the month
    status: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
    paidAt: { type: Date },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // admin who marked it paid
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

// One invoice per clinic per month — makes generation safely idempotent.
invoiceSchema.index({ doctor: 1, month: 1 }, { unique: true });

export default mongoose.model("Invoice", invoiceSchema);
