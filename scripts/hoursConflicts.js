// Read-only report: find future appointments that fall OUTSIDE a doctor's new
// clinic hours, so the clinic can reschedule + notify those patients.
//
// Configured here for the Mon/Tue/Wed 7:30–9:30 PM (19:30–21:30) change, in the
// clinic's local timezone (Asia/Karachi). Nothing is modified.
//
// Usage (from dental-app-server/):
//   DOCTOR_PHONE=03434716440 node scripts/hoursConflicts.js
//   DOCTOR_EMAIL=dr@example.com node scripts/hoursConflicts.js
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Appointment from "../models/Appointment.js";

const TZ = "Asia/Karachi";
const AFFECTED_DAYS = new Set(["Mon", "Tue", "Wed"]);
const START = 19 * 60 + 30; // 19:30
const END = 21 * 60 + 30; // 21:30

// Local-time parts of a Date in the clinic's timezone.
const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, weekday: "short", year: "numeric", month: "short",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const localParts = (d) => {
  const o = {};
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  return o; // { weekday, day, month, year, hour, minute }
};

async function run() {
  await connectDB();
  const id = (process.env.DOCTOR_PHONE || process.env.DOCTOR_EMAIL || "").trim();
  if (!id) {
    console.error("Set DOCTOR_PHONE=<phone> or DOCTOR_EMAIL=<email>");
    process.exit(1);
  }
  const query = id.includes("@") ? { email: id.toLowerCase() } : { phone: id };
  const doctor = await User.findOne({ ...query, role: "doctor" });
  if (!doctor) {
    console.error("No doctor found for:", id);
    process.exit(1);
  }

  const now = new Date();
  const appts = await Appointment.find({
    doctor: doctor._id,
    date: { $gte: now },
    status: { $in: ["scheduled", "pending"] },
  })
    .populate("client", "name phone email managed guardianName guardianPhone")
    .sort({ date: 1 });

  const conflicts = [];
  for (const a of appts) {
    const p = localParts(a.date);
    if (!AFFECTED_DAYS.has(p.weekday)) continue; // only Mon/Tue/Wed matter
    const mins = Number(p.hour) * 60 + Number(p.minute);
    if (mins >= START && mins < END) continue; // already inside 19:30–21:30
    conflicts.push({ a, p });
  }

  console.log(`\nDoctor:  ${doctor.name}  (${doctor.phone || doctor.email})`);
  console.log(`New Mon/Tue/Wed hours: 7:30 PM – 9:30 PM  (timezone ${TZ})`);
  console.log(`Future scheduled/pending appointments checked: ${appts.length}`);
  console.log(`Appointments OUTSIDE the new window (need reschedule): ${conflicts.length}\n`);

  if (conflicts.length) {
    console.log("  WHEN (local)                 TIME    STATUS     PATIENT / CONTACT                 ID");
    console.log("  " + "-".repeat(96));
    for (const { a, p } of conflicts) {
      const c = a.client || {};
      const who = c.managed
        ? `${c.name} (guardian ${c.guardianName || "-"} ${c.guardianPhone || ""})`
        : `${c.name || "-"} ${c.phone || c.email || ""}`;
      const when = `${p.weekday} ${p.day} ${p.month} ${p.year}`.padEnd(26);
      console.log(`  ${when} ${p.hour}:${p.minute}   ${String(a.status).padEnd(9)}  ${who.padEnd(32)}  ${a._id}`);
    }
    console.log("\nAction: reschedule each into a 7:30–9:30 PM slot (the app notifies the patient),");
    console.log("or contact the patient to agree a new time.\n");
  } else {
    console.log("No conflicts — nothing to reschedule.\n");
  }

  await mongoose.connection.close();
}

run().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
