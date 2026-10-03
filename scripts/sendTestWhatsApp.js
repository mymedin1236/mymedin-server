// Verify the WAHA gateway end to end: checks the session is authenticated,
// then (optionally) sends one real message to a number you name.
//
//   node scripts/sendTestWhatsApp.js                      # status check only
//   node scripts/sendTestWhatsApp.js --to=03001234567     # status + send
//   node scripts/sendTestWhatsApp.js --to=... --text="hi"
//
// The number goes through the SAME normaliser the app uses, so this also
// confirms how your stored phone formats resolve to WhatsApp chat ids.
import "dotenv/config";
import { sendWhatsApp, whatsappStatus, toChatId, whatsappConfigured } from "../utils/whatsapp.js";

const arg = (n) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

console.log(`configured : ${whatsappConfigured}`);
const status = await whatsappStatus();
console.log(`session    : ${status.status}${status.me ? ` (${status.me})` : ""}`);
if (!status.ok) {
  console.error(`\nSession is not WORKING — scan the QR at ${process.env.WAHA_URL}/dashboard first.`);
  process.exit(1);
}

const to = arg("to");
if (!to) {
  console.log("\nNo --to given, so nothing was sent. Pass --to=<number> to send a real message.");
  process.exit(0);
}
console.log(`chatId     : ${toChatId(to)}`);
const res = await sendWhatsApp({ to, text: arg("text") || "Test message from MyMedin." });
console.log(res.delivered ? `\nDelivered (id ${res.id})` : `\nNOT delivered — ${res.reason}`);
process.exit(res.delivered ? 0 : 1);
