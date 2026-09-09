import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { sendPush } from "./push.js";
import { sendMail } from "./mailer.js";

// Notify a whole clinic — the doctor AND all of their assistants — so staff
// see every clinic-facing notification the doctor gets (in-app + web push).
// Email (when provided) goes to the doctor only.
export async function notifyClinic(doctorId, { type, title, body, url, email }) {
  let recipients = [String(doctorId)];
  try {
    const assistants = await User.find({ role: "assistant", doctor: doctorId }).select("_id");
    recipients = [...new Set([...recipients, ...assistants.map((a) => String(a._id))])];
  } catch (e) {
    console.error("[notifyClinic] assistant lookup:", e?.message);
  }

  for (const uid of recipients) {
    Notification.create({ user: uid, doctor: doctorId, type, title, body, data: { url } }).catch((e) =>
      console.error("[notifyClinic] notif:", e?.message)
    );
    sendPush(uid, { title, body, url });
  }

  if (email?.to) {
    const text = `${email.greeting || ""}${body}`;
    sendMail({ to: email.to, subject: title, text, html: text.replace(/\n/g, "<br/>") }).catch(
      (e) => console.error("[notifyClinic] email:", e?.message)
    );
  }
}

// Notify a single user (in-app + web push + optional email) by their id.
export async function notifyUser(userId, { type, title, body, url, email }) {
  Notification.create({ user: userId, type, title, body, data: { url } }).catch((e) =>
    console.error("[notifyUser] notif:", e?.message)
  );
  sendPush(userId, { title, body, url });
  if (email?.to) {
    const text = `${email.greeting || ""}${body}`;
    sendMail({ to: email.to, subject: title, text, html: text.replace(/\n/g, "<br/>") }).catch(
      (e) => console.error("[notifyUser] email:", e?.message)
    );
  }
}

// Notify a single patient (in-app + web push + email). Accepts a client id or a
// loaded User doc. For a managed dependent, everything routes to the linked
// guardian's account + email instead.
export async function notifyPatient(clientOrId, { type, title, body, url }) {
  let c = clientOrId;
  if (!c || !c._id) {
    c = await User.findById(clientOrId)
      .select("name email managed guardian guardianName guardianEmail")
      .catch(() => null);
  }
  if (!c) return;

  const targetUser = c.managed ? c.guardian : c._id;
  if (targetUser) {
    Notification.create({ user: targetUser, type, title, body, data: { url } }).catch((e) =>
      console.error("[notifyPatient] notif:", e?.message)
    );
    sendPush(targetUser, { title, body, url });
  }

  const to = c.managed ? c.guardianEmail : c.email;
  if (to) {
    const greet = c.managed ? c.guardianName || "there" : c.name;
    const text = `Hi ${greet},\n\n${body}`;
    sendMail({ to, subject: title, text, html: text.replace(/\n/g, "<br/>") }).catch((e) =>
      console.error("[notifyPatient] email:", e?.message)
    );
  }
}
