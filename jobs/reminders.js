import Appointment from "../models/Appointment.js";
import Notification from "../models/Notification.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";
import { sendWhatsApp, SIGNATURE } from "../utils/whatsapp.js";

const CHECK_MS = 15 * 60 * 1000; // check every 15 minutes

// Format in the clinic's timezone (server runs in UTC) so reminders show local time.
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";
const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: CLINIC_TZ,
  });
const fmtDay = (d) =>
  new Date(d).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: CLINIC_TZ,
  });
const fmtTime = (d) =>
  new Date(d).toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: CLINIC_TZ,
  });

const HOUR = 60 * 60 * 1000;

// Reminder windows, widest first. Each fires once, when the appointment is
// inside it. Only the NARROWEST window the appointment is in is ever sent, and
// claiming it also marks every wider window as sent — so an appointment booked
// or rescheduled 2 hours out never gets a burst of "24 hours" / "12 hours"
// reminders. The 1-hour reminder is the last word and always goes out.
const WINDOWS = [
  { flag: "remind24hSent", ms: 24 * HOUR },
  { flag: "remind12hSent", ms: 12 * HOUR },
  { flag: "remind1hSent", ms: 1 * HOUR },
];
const LAST = WINDOWS[WINDOWS.length - 1];

// "in about 2 hours" / "in about 45 minutes", from the time actually left —
// never a fixed label that can be wrong when a reminder fires late.
function leadText(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 50) return `in about ${Math.max(5, Math.round(mins / 5) * 5)} minutes`;
  const hrs = Math.round(mins / 60);
  return `in about ${hrs} hour${hrs === 1 ? "" : "s"}`;
}

// Clinic address line for the 📍 bullet, plus a maps link when we have a pin.
function clinicLocation(dr) {
  if (!dr) return { line: "", map: "" };
  const parts = [dr.clinicName, dr.address, dr.area, dr.city].filter(Boolean);
  const line = [...new Set(parts)].join(", ");
  const [lng, lat] = dr.location?.coordinates || [];
  const map = lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : "";
  return { line, map };
}

// Short, scannable reminder for WhatsApp/email: one bullet per fact.
export function buildReminderText({ greet, patientName, managed, doctor, date, lead }) {
  const { line, map } = clinicLocation(doctor);
  const rows = [
    `Hi ${greet},`,
    "",
    `⏰ *Appointment Reminder* — ${lead}`,
    "",
    ...(managed ? [`👤 *Patient:* ${patientName}`] : []),
    `👨‍⚕️ *Doctor:* Dr. ${doctor?.name || ""}`.trimEnd(),
    `📅 *Date:* ${fmtDay(date)}`,
    `🕒 *Time:* ${fmtTime(date)}`,
    ...(line ? [`📍 *Location:* ${line}`] : []),
    ...(map ? [`🗺️ ${map}`] : []),
    "",
    "Please arrive 10 minutes early. If you can't make it, kindly let the clinic know.",
    "",
    SIGNATURE,
  ];
  return rows.join("\n");
}

const mailHtml = (text) =>
  text.replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/\n/g, "<br/>");

async function deliver(appt, lead) {
  const c = appt.client;
  const when = fmtWhen(appt.date);
  const who = c.managed ? `${c.name}'s` : "your";
  const body = `Reminder: ${who} appointment with Dr. ${appt.doctor?.name} is ${lead} (${when}).`;

  // For a managed dependent, notify the linked guardian's account (if any);
  // otherwise the patient. Always email the right contact.
  const targetUser = c.managed ? c.guardian : c._id;
  if (targetUser) {
    let ack;
    try {
      const n = await Notification.create({
        user: targetUser,
        type: "appointment_reminder",
        title: "Appointment reminder",
        body,
        data: { url: "/client", appointmentId: appt._id, canAcknowledge: true },
      });
      ack = String(n._id);
    } catch (e) {
      console.error("[reminder] notif:", e?.message);
    }
    const push = { title: "Appointment reminder", body, url: "/client" };
    sendPush(targetUser, ack ? { ...push, ack } : push);
  }

  const text = buildReminderText({
    greet: c.managed ? c.guardianName || "there" : c.name,
    patientName: c.name,
    managed: c.managed,
    doctor: appt.doctor,
    date: appt.date,
    lead,
  });

  const to = c.managed ? c.guardianEmail : c.email;
  if (to) {
    sendMail({ to, subject: "Appointment reminder — MyMedin", text, html: mailHtml(text) }).catch(
      (e) => console.error("[reminder] email:", e?.message)
    );
  }

  const phone = c.managed ? c.guardianPhone : c.phone;
  if (phone) {
    sendWhatsApp({ to: phone, text }).catch((e) => console.error("[reminder] whatsapp:", e?.message));
  }
}

// Send due reminders for scheduled appointments in the next 24 hours.
// Returns the number of reminders sent (used by the cron endpoint).
export async function runRemindersOnce() {
  const now = new Date();
  const due = await Appointment.find({
    status: "scheduled",
    date: { $gt: now, $lte: new Date(now.getTime() + WINDOWS[0].ms) },
    [LAST.flag]: { $ne: true },
  })
    .populate("client", "name email phone managed guardian guardianName guardianEmail guardianPhone")
    .populate("doctor", "name clinicName address area city location");

  let sent = 0;
  for (const appt of due) {
    const left = appt.date.getTime() - now.getTime();
    const inside = WINDOWS.filter((w) => left <= w.ms);
    const w = inside[inside.length - 1];
    if (appt[w.flag]) continue; // this window already went out

    // Claim atomically (window + every wider one) so the in-process timer and
    // the external cron can't both send it.
    const flags = Object.fromEntries(inside.map((x) => [x.flag, true]));
    const claim = await Appointment.updateOne(
      { _id: appt._id, date: appt.date, status: "scheduled", [w.flag]: { $ne: true } },
      { $set: flags }
    );
    if (!claim.modifiedCount) continue;

    // A 24h/12h reminder that would land with under half its lead left (e.g. a
    // booking made 3 hours out) adds nothing — the 1-hour reminder covers it.
    if (w !== LAST && left < w.ms / 2) continue;
    if (!appt.client) continue;

    await deliver(appt, leadText(left));
    sent++;
  }
  if (sent) console.log(`[reminder] sent ${sent} appointment reminder(s)`);
  return sent;
}

// In-process timer (works when the server stays awake). A managed cron hitting
// /api/cron/run-reminders covers free-tier instances that sleep.
export function startAppointmentReminders() {
  runRemindersOnce().catch((e) => console.error("[reminder] error:", e?.message));
  setInterval(
    () => runRemindersOnce().catch((e) => console.error("[reminder] error:", e?.message)),
    CHECK_MS
  );
}
