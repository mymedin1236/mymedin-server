import mongoose from "mongoose";

// Links an assistant to a doctor's clinic. An assistant may have several active
// engagements at once (they work for multiple dentists) — this is what makes the
// clinic switcher possible instead of one assistant account per dentist.
const engagementSchema = new mongoose.Schema(
  {
    assistant: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "active", "ended"],
      default: "pending",
    },
    initiatedBy: { type: String, enum: ["assistant", "doctor"], required: true },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

engagementSchema.index({ assistant: 1, status: 1 });
engagementSchema.index({ doctor: 1, status: 1 });

export default mongoose.model("Engagement", engagementSchema);
