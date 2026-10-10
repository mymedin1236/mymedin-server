// Prepare existing patients for multi-doctor care.
//
// A patient can now be with several doctors, and the approved Association rows
// are the list of them. Patients created before that may have `User.doctor` set
// with no approved Association, and their clinic notes still sit on the shared
// User record. This script, for each such patient:
//   • creates the approved Association for their current doctor, and
//   • copies `User.medicalNotes` onto that association (the clinic that wrote
//     them is the only one that should read them).
//
// SAFE by design:
//   • Dry run unless you pass --apply.
//   • Idempotent: patients that already have the association, or notes already
//     copied, are skipped.
//   • OPTIONAL: utils/careTeam.js already treats `User.doctor` as an approved
//     link and reads legacy notes, so un-migrated data keeps working.
//   • Leaves `User.medicalNotes` in place; nothing is deleted.
//
// Usage (from the mymedin-server folder, with your normal .env in place):
//   node scripts/backfillPatientAssociations.js            # dry run
//   node scripts/backfillPatientAssociations.js --apply    # write changes
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Association from "../models/Association.js";

const APPLY = process.argv.includes("--apply");

await connectDB();

const patients = await User.find({ role: "client", doctor: { $ne: null } }).select(
  "name doctor medicalNotes createdAt"
);
let created = 0;
let notesCopied = 0;

for (const p of patients) {
  const assoc = await Association.findOne({ client: p._id, doctor: p.doctor, status: "approved" });
  if (!assoc) {
    created++;
    console.log(`LINK   ${p.name} (${p._id}) -> doctor ${p.doctor}`);
    if (APPLY) {
      await Association.create({
        client: p._id,
        doctor: p.doctor,
        status: "approved",
        initiatedBy: "doctor",
        respondedAt: p.createdAt,
        medicalNotes: p.medicalNotes || undefined,
      });
    }
    if (p.medicalNotes) notesCopied++;
  } else if (p.medicalNotes && assoc.medicalNotes === undefined) {
    notesCopied++;
    console.log(`NOTES  ${p.name} (${p._id}) -> doctor ${p.doctor}`);
    if (APPLY) {
      assoc.medicalNotes = p.medicalNotes;
      await assoc.save();
    }
  }
}

console.log(
  `\n${patients.length} patients checked · ${created} links ${APPLY ? "created" : "to create"} · ` +
    `${notesCopied} notes ${APPLY ? "copied" : "to copy"}${APPLY ? "" : "  (dry run — pass --apply)"}`
);
await mongoose.disconnect();
