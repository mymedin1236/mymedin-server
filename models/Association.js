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
    // This clinic's private notes on the patient. A patient may be with several
    // doctors, so notes can't live on the shared User record — the dentist must
    // not read the eye specialist's notes. Unset means "never written here".
    medicalNotes: { type: String },
  },
  { timestamps: true }
);

associationSchema.index({ doctor: 1, status: 1 });
associationSchema.index({ client: 1, status: 1 });
associationSchema.index({ client: 1, doctor: 1, status: 1 });

export default mongoose.model("Association", associationSchema);
