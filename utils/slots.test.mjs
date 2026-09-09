// Tests for the slot engine — run with `npm run test:slots` (no framework, no
// database: the engine is pure, so plain node is enough).
//
// The BACKWARD-COMPATIBILITY cases at the top matter most: clinics that were
// running before appointment types existed must keep getting byte-identical
// slot grids, whether or not they've been through scripts/backfillAppointmentTypes.js.
import { slotsForDay, findSlotAt, overlaps } from "./slots.js";

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
  else console.log(`ok   ${name}`);
};
const times = (s) => (s || []).map((x) => x.time + (x.typeName ? `/${x.typeName}` : "") + `@${x.duration}`);

// 1. LEGACY clinic: untyped hours + slotDuration. Must be identical to before.
eq("legacy 9-11 @15",
  times(slotsForDay({ availability: [{ day: "Mon", start: "09:00", end: "11:00" }], dayOverrides: [], dayStr: "2026-09-14", dow: 1, types: [], defaultDuration: 15 })),
  ["09:00@15","09:15@15","09:30@15","09:45@15","10:00@15","10:15@15","10:30@15","10:45@15"]);

// 2. LEGACY day override (single start/end, no blocks) still honoured.
eq("legacy override",
  times(slotsForDay({ availability: [{ day: "Mon", start: "09:00", end: "17:00" }], dayOverrides: [{ date: "2026-09-14", closed: false, start: "09:00", end: "10:00" }], dayStr: "2026-09-14", dow: 1, types: [], defaultDuration: 30 })),
  ["09:00@30","09:30@30"]);

// 3. Legacy day off.
eq("legacy day off", slotsForDay({ availability: [{ day: "Mon", start: "09:00", end: "17:00" }], dayOverrides: [{ date: "2026-09-14", closed: true }], dayStr: "2026-09-14", dow: 1, types: [], defaultDuration: 15 }), []);

// 4. Clinic with NO hours configured at all -> 9-6 default (unchanged behaviour).
eq("no hours configured -> 9-18 count",
  slotsForDay({ availability: [], dayOverrides: [], dayStr: "2026-09-14", dow: 1, types: [], defaultDuration: 60 }).length, 9);

// 5. Closed weekday.
eq("closed weekday", slotsForDay({ availability: [{ day: "Tue", start: "09:00", end: "17:00" }], dayOverrides: [], dayStr: "2026-09-14", dow: 1, types: [], defaultDuration: 15 }), []);

// --- the hair-specialist requirement ---
const types = [
  { _id: "c", name: "Consultation", duration: 20 },
  { _id: "p", name: "PRP", duration: 40 },
  { _id: "h", name: "Transplant", duration: 90 },
];
const availability = [
  { day: "Mon", start: "12:00", end: "15:00", appointmentType: "c" },
  { day: "Mon", start: "16:00", end: "18:00", appointmentType: "p" },
  { day: "Mon", start: "18:00", end: "21:00", appointmentType: "h" },
];
const day = { availability, dayOverrides: [], dayStr: "2026-09-14", dow: 1, types, defaultDuration: 15 };
eq("hair specialist day", times(slotsForDay(day)),
  ["12:00/Consultation@20","12:20/Consultation@20","12:40/Consultation@20","13:00/Consultation@20","13:20/Consultation@20","13:40/Consultation@20","14:00/Consultation@20","14:20/Consultation@20","14:40/Consultation@20",
   "16:00/PRP@40","16:40/PRP@40","17:20/PRP@40",
   "18:00/Transplant@90","19:30/Transplant@90"]);

// 6. A slot that would overrun its bracket is never offered.
eq("no overrun past 21:00", times(slotsForDay(day)).filter((t)=>t.startsWith("20:")), []);

// 7. MIGRATED legacy clinic: one type at the old slotDuration == old behaviour.
eq("migrated == legacy",
  times(slotsForDay({ availability: [{ day: "Mon", start: "09:00", end: "11:00", appointmentType: "x" }], dayOverrides: [], dayStr: "2026-09-14", dow: 1, types: [{ _id: "x", name: "Consultation", duration: 15 }], defaultDuration: 15 })).map((t)=>t.replace("/Consultation","")),
  ["09:00@15","09:15@15","09:30@15","09:45@15","10:00@15","10:15@15","10:30@15","10:45@15"]);

// 8. Bracket naming a RETIRED/deleted type falls back to the clinic default
//    rather than dropping those hours off the calendar.
eq("missing type -> default duration",
  times(slotsForDay({ availability: [{ day: "Mon", start: "09:00", end: "10:00", appointmentType: "gone" }], dayOverrides: [], dayStr: "2026-09-14", dow: 1, types, defaultDuration: 30 })),
  ["09:00@30","09:30@30"]);

// 9. Mixed: one typed bracket + one untyped on the same day.
eq("mixed typed/untyped",
  times(slotsForDay({ availability: [{ day: "Mon", start: "09:00", end: "10:00" }, { day: "Mon", start: "18:00", end: "21:00", appointmentType: "h" }], dayOverrides: [], dayStr: "2026-09-14", dow: 1, types, defaultDuration: 30 })),
  ["09:00@30","09:30@30","18:00/Transplant@90","19:30/Transplant@90"]);

// 10. Typed per-date override wins over weekly hours.
eq("typed override",
  times(slotsForDay({ availability, dayOverrides: [{ date: "2026-09-14", closed: false, blocks: [{ start: "10:00", end: "13:00", appointmentType: "h" }] }], dayStr: "2026-09-14", dow: 1, types, defaultDuration: 15 })),
  ["10:00/Transplant@90","11:30/Transplant@90"]);

// 11. findSlotAt resolves the right type / rejects off-grid times.
eq("findSlotAt 18:00", findSlotAt(slotsForDay(day), 18*60)?.typeName, "Transplant");
eq("findSlotAt 18:45 off-grid", findSlotAt(slotsForDay(day), 18*60+45), null);
eq("findSlotAt 12:20", findSlotAt(slotsForDay(day), 12*60+20)?.duration, 20);

// 12. Overlap arithmetic: adjacent slots don't clash, a long one swallows shorts.
eq("adjacent 20-min ok", overlaps(720, 740, 740, 760), false);
eq("90-min blocks 19:00", overlaps(18*60, 18*60+90, 19*60, 19*60+20), true);

console.log(fails ? `\n${fails} FAILURE(S)` : "\nAll passed.");
process.exit(fails ? 1 : 0);
