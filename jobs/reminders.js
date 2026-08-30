import Appointment from "../models/Appointment.js";
import Notification from "../models/Notification.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";

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

// Reminder windows: send once when the appointment first falls within each lead time.
const WINDOWS = [
  { flag: "remind24hSent", ms: 24 * 60 * 60 * 1000, lead: "in about 24 hours" },
  { flag: "remind12hSent", ms: 12 * 60 * 60 * 1000, lead: "in about 12 hours" },
  { flag: "remind1hSent", ms: 60 * 60 * 1000, lead: "in about 1 hour" },
];

async function sendWindow({ flag, ms, lead }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + ms);

  const due = await Appointment.find({
    status: "scheduled",
    [flag]: { $ne: true },
    date: { $gt: now, $lte: cutoff },
  })
    .populate("client", "name email managed guardian guardianName guardianEmail")
    .populate("dentist", "name");

  for (const appt of due) {
    const c = appt.client;
    if (!c) {
      appt[flag] = true;
      await appt.save();
      continue;
    }
    const when = fmtWhen(appt.date);
    const who = c.managed ? `${c.name}'s` : "your";
    const body = `Reminder: ${who} appointment with Dr. ${appt.dentist?.name} is ${lead} (${when}).`;

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

    const to = c.managed ? c.guardianEmail : c.email;
    if (to) {
      const greet = c.managed ? c.guardianName || "there" : c.name;
      const text = `Hi ${greet},\n\n${body}\n\nSee you then!`;
      sendMail({
        to,
        subject: "Appointment reminder — MyMedin",
        text,
        html: text.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("[reminder] email:", e?.message));
    }

    appt[flag] = true;
    await appt.save();
  }
  return due.length;
}

// Send the 12-hour and 1-hour reminders for scheduled appointments.
// Returns the total number of reminders sent (used by the cron endpoint).
export async function runRemindersOnce() {
  let total = 0;
  for (const w of WINDOWS) {
    total += await sendWindow(w);
  }
  if (total) console.log(`[reminder] sent ${total} appointment reminder(s)`);
  return total;
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
