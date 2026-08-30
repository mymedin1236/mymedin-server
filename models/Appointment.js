import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: Date, required: true },
    reason: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["pending", "scheduled", "completed", "cancelled", "no_show"],
      default: "scheduled",
    },
    notes: { type: String },
    // Patient travel status on the day (notifies the doctor).
    arrivalStatus: {
      type: String,
      enum: ["none", "on_the_way", "arrived"],
      default: "none",
    },
    // When the patient was marked "arrived" — powers the waiting-time counter on
    // the clinic's schedule so staff can see how long each patient has waited.
    arrivedAt: { type: Date },
    // One-time reminder flags, reset whenever the appointment is (re)scheduled.
    remind24hSent: { type: Boolean, default: false }, // ~24h-before reminder sent
    remind12hSent: { type: Boolean, default: false }, // ~12h-before reminder sent
    remind1hSent: { type: Boolean, default: false }, // ~1h-before reminder sent
  },
  { timestamps: true }
);

// Make duplicate bookings impossible at the database level: a doctor can have
// at most ONE scheduled appointment at a given instant. Even if two requests
// race past the app-level "is this slot free?" check, the second insert/confirm
// hits this unique index and fails with a duplicate-key (E11000) error, which
// the routes translate into a clean "that slot was just taken" 409.
//
// Partial (status: "scheduled") so cancelled / completed / no-show rows never
// block re-booking the same slot later.
appointmentSchema.index(
  { doctor: 1, date: 1 },
  { unique: true, partialFilterExpression: { status: "scheduled" }, name: "uniq_doctor_slot_scheduled" }
);

// Whenever the appointment time changes via a document save(), re-arm the
// reminders and clear travel status so the patient is reminded for the NEW time.
// (findOneAndUpdate bypasses this hook, so the PUT route handles that path itself.)
appointmentSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified("date")) {
    this.remind24hSent = false;
    this.remind12hSent = false;
    this.remind1hSent = false;
    this.arrivalStatus = "none";
    this.arrivedAt = undefined;
  }
  next();
});

export default mongoose.model("Appointment", appointmentSchema);
