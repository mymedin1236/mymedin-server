// Create a disposable test doctor + patient + appointment, used to exercise the
// WhatsApp reminder path end to end against a real phone.
//
// It is SAFE by default:
//   • Dry run unless you pass --apply (prints exactly what it WOULD do).
//   • Reuses an existing patient when the phone is already registered, rather
//     than duplicating them (phone is a sparse UNIQUE index — a second insert
//     would fail anyway).
//   • The test doctor is created WITHOUT billing.startMonth, so the monthly
//     invoice job skips it and no real subscription invoice is ever generated.
//   • --remove deletes everything this script created, so the production
//     database can be put back exactly as it was.
//
// Usage (run from the mymedin-server folder, with your normal .env in place):
//   node scripts/seedWhatsAppTest.js --phone=03001234567              # dry run
//   node scripts/seedWhatsAppTest.js --phone=03001234567 --apply      # create
//   node scripts/seedWhatsAppTest.js --remove --apply                 # delete it again
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { toChatId } from "../utils/whatsapp.js";

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");

const DOCTOR_EMAIL = "whatsapp.test.doctor@mymedin.test";
// Kept out of version control — a real number belongs in your shell, not the repo.
const PATIENT_PHONE = (process.argv.find((a) => a.startsWith("--phone=")) || "").slice(8) ||
  process.env.TEST_PATIENT_PHONE;
const PATIENT_NAME = process.env.TEST_PATIENT_NAME || "WhatsApp Test Patient";
const PASSWORD = "TestPass1234";

// ~23 hours out: inside the 24h reminder window but outside the 12h and 1h
// ones, so the job sends EXACTLY ONE message instead of three.
const WHEN = new Date(Date.now() + 23 * 60 * 60 * 1000);

if (!PATIENT_PHONE && !REMOVE) {
  console.error("Pass --phone=<number> (or set TEST_PATIENT_PHONE) to name the test patient.");
  process.exit(1);
}

await connectDB();
console.log(APPLY ? "MODE  APPLY (will write)\n" : "MODE  dry run (no changes)\n");

if (REMOVE) {
  const doc = await User.findOne({ email: DOCTOR_EMAIL });
  if (!doc) {
    console.log("Nothing to remove — test doctor not found.");
  } else {
    const appts = await Appointment.countDocuments({ doctor: doc._id });
    console.log(`Would delete doctor ${doc.name} (${doc._id}) and ${appts} appointment(s).`);
    console.log("The patient is NOT deleted — they already existed before this script.");
    if (APPLY) {
      await Appointment.deleteMany({ doctor: doc._id });
      await User.deleteOne({ _id: doc._id });
      console.log("Deleted.");
    }
  }
  await mongoose.disconnect();
  process.exit(0);
}

// --- Doctor -----------------------------------------------------------------
let doctor = await User.findOne({ email: DOCTOR_EMAIL });
if (doctor) {
  console.log(`DOCTOR    reusing existing ${doctor.name} (${doctor._id})`);
} else {
  console.log(`DOCTOR    create "Dr Test WhatsApp" <${DOCTOR_EMAIL}> (no billing.startMonth -> never invoiced)`);
  if (APPLY) {
    doctor = await User.create({
      name: "Test WhatsApp",
      email: DOCTOR_EMAIL,
      password: PASSWORD,
      role: "doctor",
      clinicName: "WhatsApp Test Clinic",
      specialization: "Testing",
      slotDuration: 30,
      availability: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({
        day,
        start: "09:00",
        end: "21:00",
      })),
    });
    console.log(`          created ${doctor._id}`);
  }
}

// --- Patient ----------------------------------------------------------------
let patient = await User.findOne({ phone: PATIENT_PHONE });
if (patient) {
  console.log(`PATIENT   reusing existing "${patient.name}" ${patient.phone} (${patient._id})`);
} else {
  console.log(`PATIENT   create "${PATIENT_NAME}" ${PATIENT_PHONE}`);
  if (APPLY) {
    patient = await User.create({
      name: PATIENT_NAME,
      phone: PATIENT_PHONE,
      password: PASSWORD,
      role: "client",
      doctor: doctor?._id,
    });
    console.log(`          created ${patient._id}`);
  }
}
console.log(`          whatsapp -> ${toChatId(PATIENT_PHONE)}`);

// --- Appointment ------------------------------------------------------------
console.log(`APPT      ${WHEN.toISOString()}  (~23h out: fires the 24h reminder only)`);
if (APPLY) {
  if (!doctor || !patient) {
    console.error("Cannot create the appointment without both a doctor and a patient.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const appt = await Appointment.create({
    doctor: doctor._id,
    client: patient._id,
    date: WHEN,
    status: "scheduled",
    duration: 30,
    typeName: "WhatsApp test",
    reason: "Verifying WhatsApp reminder delivery",
  });
  console.log(`          created ${appt._id}`);
  console.log(`\nNow run the reminder job to send it:\n  node -e "import('./jobs/reminders.js').then(m=>m.runRemindersOnce()).then(n=>console.log('sent',n))"`);
} else {
  console.log("\nRe-run with --apply to create these.");
}

await mongoose.disconnect();
