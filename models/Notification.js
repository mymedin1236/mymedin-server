import mongoose from "mongoose";

// In-app notification for a recipient user. The client polls these and triggers
// vibration + sound when a new unread one appears.
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true }, // association_request | association_approved | association_rejected | association_ended
    title: { type: String, required: true },
    body: { type: String },
    read: { type: Boolean, default: false },
    data: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
// Auto-delete notifications 15 days after creation (MongoDB TTL index).
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 15 * 24 * 60 * 60 });

export default mongoose.model("Notification", notificationSchema);
