import mongoose from "mongoose";

// A physical clinic where several doctors sit, e.g. two dentists and a
// gynaecologist at one medical centre, each with their own hours. Set up by an
// admin. Each doctor still runs their own diary, notes and treatment history;
// the clinic only groups them.
//
// With `sharePatients` on, a patient who joins any doctor here is registered
// with every doctor here (see utils/careTeam.js). A doctor belongs to at most
// one clinic; routes/admin.js enforces that.
const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    doctors: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    sharePatients: { type: Boolean, default: true },
  },
  { timestamps: true }
);

clinicSchema.index({ doctors: 1 });

export default mongoose.model("Clinic", clinicSchema);
