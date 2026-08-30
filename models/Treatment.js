import mongoose from "mongoose";

// A single payment made toward a treatment (upfront deposit or a per-visit charge)
const paymentSchema = new mongoose.Schema(
  {
    // Usually positive; a negative amount is allowed only for a correcting
    // "Adjustment" entry when the collected total is edited downward. Normal
    // payments are still validated as positive in the routes.
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true },
    // How the payment was collected. Optional at schema level so older payments
    // (and auto-settlements) don't fail validation; enforced in the route on create.
    method: { type: String, enum: ["cash", "online"] },
  },
  { _id: true }
);

// A patient-reported problem / recall on a past treatment (e.g. pain days later).
const followUpSchema = new mongoose.Schema(
  {
    message: { type: String, trim: true, required: true },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    resolvedAt: { type: Date },
  },
  { _id: true, timestamps: { createdAt: true, updatedAt: false } }
);

const treatmentSchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },
    procedure: { type: String, required: true, trim: true },
    site: { type: String },
    diagnosis: { type: String },
    description: { type: String },
    // Post-visit prescription / care advice for the patient (e.g. "avoid hot
    // drinks"). Shown to the patient in their Treatments view.
    prescription: { type: String },
    cost: { type: Number, default: 0 }, // total agreed amount
    payments: { type: [paymentSchema], default: [] }, // upfront + per-visit charges
    paid: { type: Boolean, default: false }, // derived: balance <= 0
    date: { type: Date, default: Date.now },
    // Patient-initiated recalls/problem reports about this treatment.
    followUps: { type: [followUpSchema], default: [] },
  },
  {
    timestamps: true,
    // Guard concurrent saves: save() checks __v and throws VersionError on a stale write.
    optimisticConcurrency: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Total collected so far and remaining balance
treatmentSchema.virtual("paidAmount").get(function () {
  return (this.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
});
treatmentSchema.virtual("balance").get(function () {
  return Math.max(0, (this.cost || 0) - this.paidAmount);
});

export default mongoose.model("Treatment", treatmentSchema);
