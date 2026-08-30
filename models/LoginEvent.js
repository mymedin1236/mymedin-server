import mongoose from "mongoose";

// One row per login attempt — powers the admin login-activity audit.
const loginEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // null on failed unknown user
    name: { type: String },
    identifier: { type: String }, // email/phone used to log in
    role: { type: String },
    success: { type: Boolean, default: true },
    reason: { type: String }, // why a failed attempt failed
    pwa: { type: Boolean, default: false }, // logged in from the installed PWA vs a browser
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Fast "recent activity" queries + auto-expire old rows after 90 days.
loginEventSchema.index({ createdAt: -1 });
loginEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model("LoginEvent", loginEventSchema);
