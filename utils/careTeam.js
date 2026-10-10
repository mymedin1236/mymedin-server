import crypto from "crypto";
import User from "../models/User.js";
import Association from "../models/Association.js";
import { notifyPatient } from "./notify.js";
import { sendMail } from "./mailer.js";
import { sendWhatsApp } from "./whatsapp.js";

// A patient can be under the care of SEVERAL doctors at once (a dentist, a
// physiotherapist and an eye specialist, say). The approved Association rows
// are the source of truth for "is this patient with this doctor".
//
// `User.doctor` is kept only as the patient's PRIMARY doctor — the default when
// a request doesn't name one, and what older code paths still read. It is
// always one of the approved doctors, or unset when there are none. Records
// that predate multi-doctor support may have `User.doctor` set without an
// Association row, so the lookups below accept either.

// Ids of every patient approved at this clinic.
export const clinicPatientIds = async (doctorId) => {
  const [linked, legacy] = await Promise.all([
    Association.find({ doctor: doctorId, status: "approved" }).distinct("client"),
    User.find({ role: "client", doctor: doctorId }).distinct("_id"),
  ]);
  const seen = new Set();
  return [...linked, ...legacy].filter((id) => {
    const k = String(id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// True if the patient is approved at this clinic.
export const isClinicPatient = async (doctorId, clientId) => {
  if (!doctorId || !clientId) return false;
  const [linked, legacy] = await Promise.all([
    Association.exists({ doctor: doctorId, client: clientId, status: "approved" }),
    User.exists({ _id: clientId, role: "client", doctor: doctorId }),
  ]);
  return !!(linked || legacy);
};

// Load a patient only if they're approved at this clinic.
export const findClinicPatient = async (doctorId, clientId, select) => {
  if (!(await isClinicPatient(doctorId, clientId))) return null;
  const q = User.findOne({ _id: clientId, role: "client" });
  return select ? q.select(select) : q;
};

// Ids of every doctor this patient is approved with (primary first).
export const patientDoctorIds = async (client) => {
  const linked = await Association.find({ client: client._id, status: "approved" }).distinct("doctor");
  const ids = [client.doctor, ...linked].filter(Boolean).map(String);
  return [...new Set(ids)];
};

// Approve a patient at a clinic: create (or revive) the association and make
// it the primary doctor if the patient has none. Returns the association.
export const linkPatient = async (clientId, doctorId, initiatedBy = "doctor") => {
  const assoc = await Association.findOneAndUpdate(
    { client: clientId, doctor: doctorId, status: { $in: ["approved", "pending"] } },
    { $set: { status: "approved", respondedAt: new Date() }, $setOnInsert: { initiatedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // `doctor: null` matches both a missing and a null field.
  await User.updateOne({ _id: clientId, doctor: null }, { doctor: doctorId });
  return assoc;
};

// End a patient's link to one clinic. If it was their primary doctor, promote
// another approved doctor (or clear it).
export const unlinkPatient = async (clientId, doctorId) => {
  await Association.updateMany(
    { client: clientId, doctor: doctorId, status: { $in: ["approved", "pending"] } },
    { status: "ended", endedAt: new Date() }
  );
  const user = await User.findById(clientId).select("doctor");
  if (user && String(user.doctor || "") === String(doctorId)) {
    const next = await Association.findOne({ client: clientId, status: "approved" }).sort({ createdAt: 1 });
    user.doctor = next ? next.doctor : undefined;
    await user.save();
  }
  return Association.exists({ client: clientId, status: "approved" });
};

// The clinic's private notes on a patient. Notes now live on the association
// so one specialist never sees another's. A note written before that lives on
// the User record, and belongs to whichever clinic was the primary then.
export const clinicNotesFor = async (doctorId, client) => {
  const a = await Association.findOne({ doctor: doctorId, client: client._id, status: "approved" }).select(
    "medicalNotes"
  );
  if (a?.medicalNotes !== undefined) return a.medicalNotes;
  return String(client.doctor || "") === String(doctorId) ? client.medicalNotes || "" : "";
};

// Swap the shared User.medicalNotes for this clinic's own notes before a
// patient record is sent to clinic staff.
export const withClinicNotes = async (doctorId, client) => {
  const obj = client.toJSON ? client.toJSON() : { ...client };
  obj.medicalNotes = await clinicNotesFor(doctorId, client);
  return obj;
};

// Bulk version for lists: one query for every association.
export const withClinicNotesMany = async (doctorId, clients) => {
  const rows = await Association.find({
    doctor: doctorId,
    status: "approved",
    client: { $in: clients.map((c) => c._id) },
  }).select("client medicalNotes");
  const byClient = new Map(rows.map((r) => [String(r.client), r.medicalNotes]));
  return clients.map((c) => {
    const obj = c.toJSON ? c.toJSON() : { ...c };
    const own = byClient.get(String(c._id));
    obj.medicalNotes =
      own !== undefined ? own : String(c.doctor || "") === String(doctorId) ? c.medicalNotes || "" : "";
    return obj;
  });
};

// Write this clinic's private notes on a patient.
export const setClinicNotes = (doctorId, client, notes) =>
  Association.findOneAndUpdate(
    { doctor: doctorId, client: client._id, status: "approved" },
    { $set: { medicalNotes: notes || "" }, $setOnInsert: { initiatedBy: "doctor", respondedAt: new Date() } },
    { upsert: true }
  );

// An account already using this email or phone, if any.
export const findExistingByContact = async (email, phone) => {
  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (!or.length) return null;
  return User.findOne({ $or: or });
};

// The 409 body when staff try to register someone who already has an account.
// For a patient, it names them so staff can add them to this clinic instead of
// creating a duplicate.
export const existingPatientConflict = async (existing, doctorId) => {
  if (existing.role !== "client") {
    return {
      message: "This phone or email belongs to a staff/vendor account, not a patient.",
      code: "CONTACT_IN_USE",
    };
  }
  const patient = { _id: existing._id, name: existing.name };
  if (await isClinicPatient(doctorId, existing._id)) {
    return { message: `${existing.name} is already a patient at this clinic.`, code: "ALREADY_PATIENT", patient };
  }
  return {
    message: `${existing.name} is already registered on MyMedin with another doctor. Add them to your clinic too?`,
    code: "PATIENT_EXISTS",
    patient,
  };
};

const loginUrl = () =>
  (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(",")[0].trim().replace(/\/+$/, "") + "/login";

// Tell a patient that another clinic has added them. Best-effort, never awaited
// by callers for delivery.
export const announceLink = async (doctorId, client) => {
  const d = await User.findById(doctorId).select("name clinicName");
  const where = d?.clinicName ? ` at ${d.clinicName}` : "";
  const body =
    `Dr. ${d?.name || "A doctor"}${where} added you as a patient on MyMedin. ` +
    `You can now see and book appointments with them alongside your other doctors.`;
  // Routes to the guardian for a managed child, on every channel.
  await notifyPatient(client, { type: "association_approved", title: "New doctor added", body, url: "/client" });
};

// Create a new adult patient at a clinic, approve them there, and send them
// their login. With no password given (quick add while booking), a random one
// is generated and sent to the patient — they're asked to change it.
// Returns { client, credentials, shareMessage }.
export const createClinicPatient = async (doctorId, { name, email, phone, password, dateOfBirth }) => {
  const pwd = password || crypto.randomBytes(5).toString("hex"); // 10 chars
  const client = await User.create({
    name,
    email,
    password: pwd,
    role: "client",
    phone,
    dateOfBirth,
    doctor: doctorId,
  });
  await Association.create({
    client: client._id,
    doctor: doctorId,
    status: "approved",
    initiatedBy: "doctor",
    respondedAt: new Date(),
  });

  // The credentials message names the doctor, even if an assistant created it.
  const owner = await User.findById(doctorId).select("name");
  const shareMessage =
    `Hi ${name}, Dr. ${owner?.name || ""} created your MyMedin account.\n\n` +
    `Login: ${loginUrl()}\n` +
    (email ? `Email: ${email}\n` : `Phone: ${phone}\n`) +
    `Password: ${pwd}\n\n` +
    `Please sign in and change your password.`;

  if (email) {
    sendMail({
      to: email,
      subject: "Your MyMedin account",
      text: shareMessage,
      html: shareMessage.replace(/\n/g, "<br/>"),
    }).catch((e) => console.error("creds email failed:", e?.message));
  }
  // Most patients register with a phone and no email, so without this their
  // login never reaches them and staff have to paste it by hand.
  if (phone) {
    sendWhatsApp({ to: phone, text: shareMessage }).catch((e) =>
      console.error("creds whatsapp failed:", e?.message)
    );
  }
  return { client, credentials: { email: email || "", phone: phone || "", password: pwd }, shareMessage };
};
