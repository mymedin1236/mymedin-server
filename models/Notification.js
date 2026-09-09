import mongoose from "mongoose";

// In-app notification for a recipient user. The client polls these and triggers
// vibration + sound when a new unread one appears.
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Which clinic this notification belongs to — set on clinic-fanout notifications
    // (see notifyClinic() in utils/notify.js) so an assistant engaged with several
    // doctors only sees the active clinic's notifications. Unset for notifications
    // addressed to a non-staff user (e.g. a patient), who only has one identity.
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
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
