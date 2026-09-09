// Put existing clinics onto the appointment-types model WITHOUT changing how
// their calendar behaves.
//
// Before this feature a clinic had one slot length (`slotDuration`) applied to
// every operational-hours bracket. This script gives each such clinic a single
// "Consultation" type at EXACTLY that length, points its existing hours at it,
// and stamps the same length onto its existing appointments. Nothing moves:
// a clinic on 15-minute hours keeps 15-minute slots, in the same brackets, on
// the same days. It simply now has a type it can rename, re-time, or sit
// alongside new ones (PRP, transplant, ...) whenever the doctor chooses to.
//
// SAFE by design:
//   • Dry run unless you pass --apply (prints exactly what it WOULD do).
//   • Skips any clinic that already has appointment types — a doctor who has
//     already opted in is never touched, so the script is idempotent and can be
//     re-run after new clinics sign up.
//   • Only fills in blanks: brackets that already name a type and appointments
//     that already carry a duration are left exactly as they are.
//   • Running it is OPTIONAL. The app already treats a bracket with no type as
//     "clinic default slot length", so an un-migrated clinic keeps working
//     unchanged either way. This script only makes that implicit state explicit.
//
// Usage (from the mymedin-server folder, with your normal .env in place):
//   node scripts/backfillAppointmentTypes.js                  # dry run
//   node scripts/backfillAppointmentTypes.js --apply          # write changes
//   node scripts/backfillAppointmentTypes.js --apply --doctor <id>   # one clinic
//   node scripts/backfillAppointmentTypes.js --apply --name "Check-up"
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import AppointmentType from "../models/AppointmentType.js";
import { DEFAULT_SLOT_MINUTES } from "../utils/slots.js";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};

const APPLY = process.argv.includes("--apply");
const ONLY_DOCTOR = argOf("--doctor");
const TYPE_NAME = argOf("--name") || "Consultation";

await connectDB();

const filter = { role: "doctor" };
if (ONLY_DOCTOR) {
  if (!mongoose.isValidObjectId(ONLY_DOCTOR)) {
    console.error(`--doctor ${ONLY_DOCTOR} is not a valid id`);
    process.exit(1);
  }
  filter._id = ONLY_DOCTOR;
}

const doctors = await User.find(filter).select("name clinicName slotDuration availability dayOverrides");
console.log(
  `${APPLY ? "APPLYING" : "DRY RUN"} — ${doctors.length} clinic(s) to consider. Type name: "${TYPE_NAME}".\n`
);

let migrated = 0;
let skipped = 0;

for (const doc of doctors) {
  const label = `${doc.clinicName || doc.name} (${doc._id})`;

  // Already opted in — leave this clinic completely alone.
  const existing = await AppointmentType.countDocuments({ doctor: doc._id });
  if (existing) {
    skipped += 1;
    console.log(`- SKIP  ${label}: already has ${existing} appointment type(s).`);
    continue;
  }

  const duration = doc.slotDuration || DEFAULT_SLOT_MINUTES;
  const brackets = (doc.availability || []).filter((a) => !a.appointmentType).length;
  // Overrides still in the pre-types single-window shape get converted to the
  // typed `blocks` array; ones already using blocks are only filled in.
  const overrides = (doc.dayOverrides || []).filter(
    (o) => !o.closed && ((!o.blocks?.length && o.start && o.end) || (o.blocks || []).some((b) => !b.appointmentType))
  ).length;
  const appts = await Appointment.countDocuments({ doctor: doc._id, duration: { $in: [null, undefined] } });

  console.log(
    `- ${APPLY ? "MIGRATE" : "would migrate"} ${label}: "${TYPE_NAME}" @ ${duration} min` +
      ` | ${brackets} hours bracket(s), ${overrides} date override(s), ${appts} appointment(s)`
  );

  if (!APPLY) {
    migrated += 1;
    continue;
  }

  const type = await AppointmentType.create({
    doctor: doc._id,
    name: TYPE_NAME,
    duration,
    order: 0,
    description: "Standard appointment — migrated from this clinic's original slot length.",
  });

  // Weekly hours: every untyped bracket becomes a bracket of the new type.
  doc.availability = (doc.availability || []).map((a) =>
    a.appointmentType ? a : { day: a.day, start: a.start, end: a.end, appointmentType: type._id }
  );

  // Per-date exceptions: normalise to `blocks`, carrying the new type across.
  doc.dayOverrides = (doc.dayOverrides || []).map((o) => {
    if (o.closed) return { date: o.date, closed: true, blocks: [] };
    const raw = o.blocks?.length ? o.blocks : [{ start: o.start, end: o.end }];
    return {
      date: o.date,
      closed: false,
      blocks: raw
        .filter((b) => b.start && b.end)
        .map((b) => ({ start: b.start, end: b.end, appointmentType: b.appointmentType || type._id })),
    };
  });
  await doc.save();

  // Existing appointments were all of this one kind, at this one length. Giving
  // them an explicit duration is what keeps the new overlap check exact for
  // them; without it they'd fall back to the clinic default anyway, so this is
  // belt-and-braces rather than a behaviour change.
  const r = await Appointment.updateMany(
    { doctor: doc._id, duration: { $in: [null, undefined] } },
    { $set: { duration, appointmentType: type._id, typeName: TYPE_NAME } }
  );
  console.log(`    ✓ type created, hours re-pointed, ${r.modifiedCount} appointment(s) stamped.`);
  migrated += 1;
}

console.log(
  `\n${APPLY ? "Done" : "Dry run complete"}: ${migrated} clinic(s) ${APPLY ? "migrated" : "would be migrated"}, ${skipped} skipped.`
);
if (!APPLY) console.log("Re-run with --apply to write these changes.");

await mongoose.connection.close();
process.exit(0);
