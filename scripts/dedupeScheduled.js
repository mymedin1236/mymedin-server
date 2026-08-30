// Resolve duplicate SCHEDULED appointments so the uniq_dentist_slot_scheduled
// index can build (it fails while any dentist has two "scheduled" rows at the
// same instant).
//
// It is SAFE by default:
//   • Dry run unless you pass --apply (prints exactly what it WOULD do).
//   • Only collapses EXACT duplicates — same dentist + same time + SAME patient.
//     The kept record is the earliest-created one; the extras are cancelled
//     (reversible) or, with --delete, removed.
//   • Two DIFFERENT patients at the same dentist+time is a real double-booking:
//     it is only REPORTED, never auto-changed — reschedule/cancel one yourself.
//
// Usage (run from the dental-app-server folder, with your normal .env in place):
//   node scripts/dedupeScheduled.js                 # dry run (no changes)
//   node scripts/dedupeScheduled.js --apply          # cancel the duplicate extras
//   node scripts/dedupeScheduled.js --apply --delete # delete the extras instead
//
// After it reports "0 duplicate slots" remaining, restart the server and the
// index will build automatically.
import "dotenv/config";
import { connectDB } from "../config/db.js";
import Appointment from "../models/Appointment.js";

const APPLY = process.argv.includes("--apply");
const DELETE = process.argv.includes("--delete");
const action = DELETE ? "delete" : "cancel";

await connectDB();

// Groups of scheduled appointments that share the exact same dentist + instant.
const groups = await Appointment.aggregate([
  { $match: { status: "scheduled" } },
  {
    $group: {
      _id: { dentist: "$dentist", date: "$date" },
      count: { $sum: 1 },
      rows: { $push: { id: "$_id", client: "$client", createdAt: "$createdAt" } },
    },
  },
  { $match: { count: { $gt: 1 } } },
  { $sort: { "_id.date": 1 } },
]);

let dupGroups = 0;
let extrasActed = 0;
const conflicts = [];

for (const g of groups) {
  const rows = g.rows
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const clients = new Set(rows.map((r) => String(r.client)));
  const whenISO = new Date(g._id.date).toISOString();

  if (clients.size === 1) {
    // Exact accidental duplicate — keep the first, act on the rest.
    dupGroups++;
    const [keep, ...extras] = rows;
    extrasActed += extras.length;
    console.log(
      `DUP      dentist=${g._id.dentist} date=${whenISO} patient=${[...clients][0]} ` +
        `keep=${keep.id} ${action}=${extras.map((e) => e.id).join(",")}`
    );
    if (APPLY) {
      for (const ex of extras) {
        if (DELETE) await Appointment.deleteOne({ _id: ex.id });
        else await Appointment.updateOne({ _id: ex.id }, { $set: { status: "cancelled" } });
      }
    }
  } else {
    // Different patients at the same slot — needs a human decision.
    conflicts.push({
      dentist: String(g._id.dentist),
      date: whenISO,
      appointments: rows.map((r) => ({ id: String(r.id), patient: String(r.client) })),
    });
    console.log(
      `CONFLICT dentist=${g._id.dentist} date=${whenISO} ` +
        `patients=${rows.map((r) => String(r.client)).join(" , ")}  (NOT changed — resolve manually)`
    );
  }
}

console.log("\n=== Summary ===");
console.log(`Exact duplicate slots (same patient): ${dupGroups} group(s), ${extrasActed} extra record(s) to ${action}.`);
console.log(`Real double-bookings (different patients): ${conflicts.length} group(s) — must be resolved manually.`);

if (conflicts.length) {
  console.log("\nDouble-bookings needing manual action (reschedule or cancel one of each):");
  console.log(JSON.stringify(conflicts, null, 2));
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing was changed.");
  console.log("Re-run with --apply to apply (add --delete to remove the extras instead of cancelling them).");
} else {
  console.log(`\nApplied: ${extrasActed} extra duplicate record(s) ${DELETE ? "deleted" : "cancelled"}.`);
  if (conflicts.length) {
    console.log("The index will still fail to build until the double-bookings above are resolved.");
  } else {
    console.log("Restart the server — the uniq_dentist_slot_scheduled index will now build.");
  }
}

process.exit(0);
