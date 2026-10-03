// WhatsApp delivery via a self-hosted WAHA gateway (https://waha.devlike.pro).
// Mirrors mailer.js: configured from the environment, never throws, and logs
// the message instead of sending when the gateway isn't set up — so flows stay
// testable in dev without a live WhatsApp session.

export const whatsappConfigured = !!(
  process.env.WHATSAPP_ENABLED === "true" &&
  process.env.WAHA_URL &&
  process.env.WAHA_API_KEY &&
  process.env.WAHA_SESSION
);

const BASE = (process.env.WAHA_URL || "").replace(/\/+$/, "");
const SESSION = process.env.WAHA_SESSION;
// Numbers are stored as free text (0300…, +92 300…, 923001234567), so every
// one is normalised to E.164 digits before sending. Default country is Pakistan.
const CC = process.env.WHATSAPP_COUNTRY_CODE || "92";

// Surface config at boot so deploy logs reveal misconfiguration immediately.
console.log(
  `[whatsapp] configured=${whatsappConfigured}` +
    (whatsappConfigured ? ` session="${SESSION}"` : " (set WHATSAPP_ENABLED=true + WAHA_* to enable)")
);

// Turn a stored phone number into a WAHA chat id ("923001234567@c.us").
// Returns null when the number can't be made sense of, so callers skip it
// rather than firing a doomed request.
export function toChatId(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2); // 0092… -> 92…
  if (d.startsWith(CC) && d.length > 10) {
    // already international — leave it
  } else if (d.startsWith("0")) {
    d = CC + d.slice(1); // 0300… -> 92300…
  } else if (d.length <= 10) {
    d = CC + d; // 300… -> 92300…
  }
  if (d.length < 10 || d.length > 15) return null; // E.164 sanity check
  return `${d}@c.us`;
}

// Send a WhatsApp text message. `to` is a raw phone number from the database.
// Never throws — failures are logged and reported via the return value, exactly
// like sendMail, so a gateway outage can never break a booking or a payment.
export async function sendWhatsApp({ to, text }) {
  const chatId = toChatId(to);
  if (!chatId) {
    const reason = `unusable phone number "${to}"`;
    console.warn(`[whatsapp] ${reason} — not sent.`);
    return { delivered: false, reason };
  }
  if (!whatsappConfigured) {
    const reason = "WAHA not configured";
    console.warn(`\n[whatsapp] ${reason} — message NOT sent.\n  To: ${chatId}\n  ${text}\n`);
    return { delivered: false, reason };
  }
  try {
    const res = await fetch(`${BASE}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": process.env.WAHA_API_KEY },
      body: JSON.stringify({ session: SESSION, chatId, text }),
      // The gateway may be on a sleeping free tier; cap the wait so a slow
      // cold start can't stall a reminder run.
      signal: AbortSignal.timeout(Number(process.env.WAHA_TIMEOUT_MS) || 30000),
    });
    if (!res.ok) {
      const reason = `WAHA ${res.status}: ${(await res.text()).slice(0, 200)}`;
      console.error(`[whatsapp] send to ${chatId} rejected — ${reason}`);
      return { delivered: false, reason };
    }
    const data = await res.json().catch(() => ({}));
    console.log(`[whatsapp] sent to ${chatId} (id ${data?.id || "?"})`);
    return { delivered: true, id: data?.id };
  } catch (err) {
    const reason = err.name === "TimeoutError" ? "gateway timed out" : err.message || String(err);
    console.error(`[whatsapp] send to ${chatId} threw: ${reason}`);
    return { delivered: false, reason };
  }
}

// Is the WhatsApp session actually authenticated and ready? This reaches out to
// the gateway, so it is for the CLI check in scripts/sendTestWhatsApp.js rather
// than the unthrottled /api/health, which only reports whether the env vars are
// present ("configured") and never makes a network call.
export async function whatsappStatus() {
  if (!whatsappConfigured) return { ok: false, status: "not_configured" };
  try {
    const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(SESSION)}`, {
      headers: { "X-Api-Key": process.env.WAHA_API_KEY },
      signal: AbortSignal.timeout(Number(process.env.WAHA_TIMEOUT_MS) || 30000),
    });
    if (!res.ok) return { ok: false, status: `WAHA ${res.status}` };
    const s = await res.json();
    return { ok: s?.status === "WORKING", status: s?.status, me: s?.me?.id };
  } catch (err) {
    return { ok: false, status: err.message || String(err) };
  }
}
