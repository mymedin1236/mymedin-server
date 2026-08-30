import Treatment from "../models/Treatment.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";

// Remind patients with an unpaid treatment balance every 15 days (in-app + push
// + email). A per-patient timestamp (User.lastBalanceReminderAt) gates the
// cadence, so this can run as often as the scheduler likes without over-sending.

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const CHECK_MS = 12 * 60 * 60 * 1000; // in-process fallback timer: twice a day

const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

export async function runBalanceRemindersOnce() {
  const now = new Date();

  // Sum the outstanding amount per patient across all their treatments.
  // (balance is a virtual, so compute cost − payments in the pipeline.)
  const rows = await Treatment.aggregate([
    { $addFields: { paidAmount: { $sum: "$payments.amount" } } },
    { $addFields: { outstanding: { $subtract: [{ $ifNull: ["$cost", 0] }, "$paidAmount"] } } },
    { $match: { outstanding: { $gt: 0 } } },
    { $group: { _id: "$client", total: { $sum: "$outstanding" }, dentist: { $first: "$dentist" } } },
  ]);

  let sent = 0;
  for (const row of rows) {
    const client = await User.findById(row._id).select(
      "name email managed guardian guardianName guardianEmail lastBalanceReminderAt"
    );
    if (!client) continue;

    // Only every 15 days per patient.
    if (
      client.lastBalanceReminderAt &&
      now - new Date(client.lastBalanceReminderAt) < FIFTEEN_DAYS_MS
    ) {
      continue;
    }

    const dentist = row.dentist ? await User.findById(row.dentist).select("name") : null;
    const drName = dentist?.name ? `Dr. ${dentist.name}` : "your dentist";
    const whose = client.managed ? `${client.name}'s` : "your";
    const title = "Outstanding balance";
    const body = `You have an outstanding balance of ${money(row.total)} on ${whose} dental treatment with ${drName}. Please clear it at your next visit.`;

    // Managed dependents notify the linked guardian's account; others notify self.
    const targetUser = client.managed ? client.guardian : client._id;
    if (targetUser) {
      await Notification.create({
        user: targetUser,
        type: "balance_reminder",
        title,
        body,
        data: { url: "/client/treatments" },
      }).catch((e) => console.error("[balance] notif:", e?.message));
      sendPush(targetUser, { title, body, url: "/client/treatments" });
    }

    const to = client.managed ? client.guardianEmail : client.email;
    if (to) {
      const greet = client.managed ? client.guardianName || "there" : client.name;
      const text = `Hi ${greet},\n\n${body}\n\nThank you,\nMyDentalBooking`;
      sendMail({
        to,
        subject: "Outstanding balance — MyDentalBooking",
        text,
        html: text.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("[balance] email:", e?.message));
    }

    client.lastBalanceReminderAt = now;
    await client.save().catch((e) => console.error("[balance] save:", e?.message));
    sent++;
  }

  if (sent) console.log(`[balance] sent ${sent} outstanding-balance reminder(s)`);
  return sent;
}

// In-process timer (for always-on instances). A managed cron hitting
// /api/cron/run-reminders also triggers this for free-tier instances that sleep.
export function startBalanceReminders() {
  runBalanceRemindersOnce().catch((e) => console.error("[balance] error:", e?.message));
  setInterval(
    () => runBalanceRemindersOnce().catch((e) => console.error("[balance] error:", e?.message)),
    CHECK_MS
  );
}
