import SystemState from "../models/SystemState.js";
import { sendMail } from "../utils/mailer.js";
import { whatsappConfigured, whatsappStatus } from "../utils/whatsapp.js";

// Watches the WAHA WhatsApp session and emails an alert the moment it stops
// WORKING (and again when it recovers), so a dropped link never silently stops
// reminders and payment messages. Two triggers feed it:
//   • WAHA's "session.status" webhook  -> instant (routes/webhooks.js)
//   • a 5-minute poll + the external cron -> fallback if the webhook is missed
const CHECK_MS = 5 * 60 * 1000;
const REPEAT_MS = 6 * 60 * 60 * 1000; // re-alert every 6h while still down
const KEY = "whatsapp_watch";

// Statuses that mean messages can't go out. STARTING is transient, so it's
// left to the next check rather than alerting on every restart blip.
const DOWN = new Set(["FAILED", "STOPPED", "SCAN_QR_CODE"]);

const recipients = () =>
  (process.env.WHATSAPP_ALERT_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const fmtNow = () =>
  new Date().toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: process.env.CLINIC_TZ || "Asia/Karachi",
  });

async function alert(subject, lines) {
  const text = lines.join("\n");
  const html = lines.map((l) => l || "&nbsp;").join("<br/>");
  // One send per address: in Resend test mode a single unverified recipient
  // would otherwise reject the whole message.
  for (const to of recipients()) {
    const r = await sendMail({ to, subject, text, html });
    if (!r?.delivered) console.error(`[whatsapp-watch] alert to ${to} failed: ${r?.reason}`);
  }
}

// Record a status and email on a change between up and down. `status` comes
// from the webhook payload; when omitted the gateway is asked directly.
export async function checkWhatsAppOnce(status) {
  if (!whatsappConfigured || !recipients().length) return null;
  if (!status) status = (await whatsappStatus()).status;
  if (status === "STARTING") return status;

  // A gateway that doesn't answer at all (asleep, crashed) is also "down".
  const down = status !== "WORKING";
  if (down && !DOWN.has(status)) console.warn(`[whatsapp-watch] gateway status: ${status}`);

  const prev = (await SystemState.findOne({ key: KEY }).lean())?.value || {};
  const now = Date.now();
  const dashboard = `${(process.env.WAHA_URL || "").replace(/\/+$/, "")}/dashboard`;

  if (down) {
    const due = !prev.down || now - (prev.alertedAt || 0) >= REPEAT_MS;
    if (due) {
      await alert(`⚠️ MyMedin WhatsApp is DOWN (${status})`, [
        "The MyMedin WhatsApp gateway is not connected.",
        "",
        `• Status: ${status}`,
        `• Since: ${prev.down ? new Date(prev.since).toLocaleString("en-GB", { timeZone: process.env.CLINIC_TZ || "Asia/Karachi" }) : fmtNow()}`,
        "• Impact: appointment reminders and payment messages are NOT being sent on WhatsApp.",
        "",
        "How to fix:",
        `1. Open ${dashboard}`,
        `2. Start (or restart) the session "${process.env.WAHA_SESSION}".`,
        "3. If it shows a QR code, scan it from the business phone: WhatsApp → Linked devices → Link a device.",
        "",
        "You'll get another email when it's back up.",
      ]);
    }
    await SystemState.updateOne(
      { key: KEY },
      { $set: { value: { down: true, status, since: prev.down ? prev.since : now, alertedAt: due ? now : prev.alertedAt } } },
      { upsert: true }
    );
  } else {
    if (prev.down) {
      await alert("✅ MyMedin WhatsApp is back UP", [
        "The MyMedin WhatsApp gateway is connected again.",
        "",
        `• Status: WORKING`,
        `• Back up at: ${fmtNow()}`,
        `• Was down since: ${new Date(prev.since).toLocaleString("en-GB", { timeZone: process.env.CLINIC_TZ || "Asia/Karachi" })}`,
        "",
        "Reminders and payment messages are being sent again.",
      ]);
    }
    if (prev.down || !prev.status) {
      await SystemState.updateOne({ key: KEY }, { $set: { value: { down: false, status } } }, { upsert: true });
    }
  }
  return status;
}

export function startWhatsAppWatch() {
  const run = () => checkWhatsAppOnce().catch((e) => console.error("[whatsapp-watch] error:", e?.message));
  run();
  setInterval(run, CHECK_MS);
}
