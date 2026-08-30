import mongoose from "mongoose";

// Links a client to a doctor. Created directly (approved) when a doctor adds a
// client, or as a pending request when a client self-associates from discovery.
const associationSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "ended"],
      default: "pending",
    },
    initiatedBy: { type: String, enum: ["client", "doctor"], required: true },
    respondedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

associationSchema.index({ doctor: 1, status: 1 });
associationSchema.index({ client: 1, status: 1 });

export default mongoose.model("Association", associationSchema);
