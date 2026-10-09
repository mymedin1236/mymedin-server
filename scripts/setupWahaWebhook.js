// Point the WAHA session's "session.status" webhook at this server so a dropped
// WhatsApp link triggers an instant alert email (see jobs/whatsappWatch.js).
// Run once after deploying, and again if the server URL or secret changes:
//
//   node scripts/setupWahaWebhook.js
//
// Needs WAHA_URL, WAHA_API_KEY, WAHA_SESSION, API_BASE_URL and WAHA_WEBHOOK_SECRET.
import "dotenv/config";

const BASE = (process.env.WAHA_URL || "").replace(/\/+$/, "");
const SESSION = process.env.WAHA_SESSION;
const SECRET = process.env.WAHA_WEBHOOK_SECRET;
const API = (process.env.API_BASE_URL || "").replace(/\/+$/, "");
if (!BASE || !SESSION || !process.env.WAHA_API_KEY || !SECRET || !API) {
  console.error("Missing WAHA_URL / WAHA_API_KEY / WAHA_SESSION / WAHA_WEBHOOK_SECRET / API_BASE_URL.");
  process.exit(1);
}
const H = { "X-Api-Key": process.env.WAHA_API_KEY, "Content-Type": "application/json" };
const url = `${API}/api/webhooks/waha`;

const cur = await (await fetch(`${BASE}/api/sessions/${encodeURIComponent(SESSION)}`, { headers: H })).json();
const config = cur.config || {};
const others = (config.webhooks || []).filter((w) => w.url !== url);
config.webhooks = [
  ...others,
  {
    url,
    events: ["session.status"],
    customHeaders: [{ name: "X-Webhook-Secret", value: SECRET }],
    retries: { policy: "exponential", delaySeconds: 5, attempts: 5 },
  },
];

const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(SESSION)}`, {
  method: "PUT",
  headers: H,
  body: JSON.stringify({ name: SESSION, config }),
});
console.log(res.ok ? `Webhook set -> ${url}` : `Failed: ${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
