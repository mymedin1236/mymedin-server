import mongoose from "mongoose";

// Links a client to a dentist. Created directly (approved) when a dentist adds a
// client, or as a pending request when a client self-associates from discovery.
const associationSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "ended"],
      default: "pending",
    },
    initiatedBy: { type: String, enum: ["client", "dentist"], required: true },
    respondedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

associationSchema.index({ dentist: 1, status: 1 });
associationSchema.index({ client: 1, status: 1 });

export default mongoose.model("Association", associationSchema);
