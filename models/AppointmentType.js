import mongoose from "mongoose";

// A kind of appointment the clinic offers, with its own slot length — e.g.
// "Consultation" (20 min), "PRP session" (40 min), "Hair transplant" (90 min).
// Operational-hours brackets point at one of these, which is what lets a single
// day run several kinds of appointment at different cadences.
//
// Types belong to the clinic OWNER (the doctor); assistants read/write their
// doctor's types via clinicId(), exactly like clinic hours.
const appointmentTypeSchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Length of one slot of this type, in minutes.
    duration: { type: Number, required: true, min: 5, max: 480 },
    // Optional colour so the schedule/slot grid can tell types apart at a glance.
    color: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "", maxlength: 200 },
    // Retired types are hidden from the editors but kept so existing
    // appointments (and past hours) still resolve their name.
    active: { type: Boolean, default: true },
    // Display order in the settings editor and the slot grid legend.
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One type per name per clinic — stops "Consultation" being created twice.
appointmentTypeSchema.index({ doctor: 1, name: 1 }, { unique: true });

export default mongoose.model("AppointmentType", appointmentTypeSchema);
