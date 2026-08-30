import { Resend } from "resend";

// Configured only when a Resend API key is present in the environment.
export const mailerConfigured = !!process.env.RESEND_API_KEY;

const resend = mailerConfigured ? new Resend(process.env.RESEND_API_KEY) : null;
// Use a verified domain sender in production; onboarding@resend.dev works for testing.
const FROM = process.env.MAIL_FROM || "MyDentalBooking <onboarding@resend.dev>";

// Surface mail config at boot so deploy logs reveal misconfiguration immediately.
console.log(
  `[mailer] configured=${mailerConfigured} from="${FROM}"` +
    (mailerConfigured ? "" : " (set RESEND_API_KEY to enable email)")
);

// Sends an email via Resend. When no API key is configured, logs the contents
// to the server console so flows (e.g. password reset links) stay testable in dev.
// Never throws — email failures are logged and reported via the return value.
export async function sendMail({ to, subject, text, html }) {
  if (!resend) {
    const reason = "RESEND_API_KEY not set";
    console.warn(
      `\n[mailer] ${reason} — email NOT sent.\n  To: ${to}\n  Subject: ${subject}\n  ${text}\n`
    );
    return { delivered: false, reason };
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM, to, subject, text, html });
    if (error) {
      // Resend errors carry name/statusCode/message — log all of it so the cause is obvious.
      const reason = `${error.name || "error"}: ${error.message || JSON.stringify(error)}`;
      console.error(
        `[mailer] Resend rejected send to ${to} (from "${FROM}"): ${reason}`
      );
      return { delivered: false, reason };
    }
    console.log(`[mailer] sent to ${to} (id ${data?.id})`);
    return { delivered: true, id: data?.id };
  } catch (err) {
    const reason = err.message || String(err);
    console.error(`[mailer] send to ${to} threw: ${reason}`);
    return { delivered: false, reason };
  }
}
