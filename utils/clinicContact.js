import User from "../models/User.js";
import Engagement from "../models/Engagement.js";
import { toChatId } from "./whatsapp.js";

// Keeps the doctor's `assistantName` and `assistantPhone` (the "Assistant to
// doctor" line in patient WhatsApp messages, editable in Settings) in step with
// the clinic's staff.

const samePhone = (a, b) => !!a && !!b && toChatId(a) === toChatId(b);

// An assistant joined: use their name and phone if the clinic hasn't set a
// number yet. A number the doctor typed in Settings is never overwritten; if
// it's this assistant's number with no name, the name is added.
export async function fillAssistantPhone(doctorId, assistant) {
  const phone = String(assistant?.phone || "").trim();
  if (!phone || !toChatId(phone)) return;
  const name = String(assistant?.name || "").trim();
  const filled = await User.updateOne(
    { _id: doctorId, $or: [{ assistantPhone: { $exists: false } }, { assistantPhone: "" }] },
    { $set: { assistantPhone: phone, assistantName: name } }
  );
  if (filled.modifiedCount || !name) return;
  const doctor = await User.findById(doctorId).select("assistantPhone assistantName").lean();
  if (doctor && !doctor.assistantName && samePhone(doctor.assistantPhone, phone)) {
    await User.updateOne({ _id: doctorId }, { $set: { assistantName: name } });
  }
}

// An assistant left: if the clinic's number is theirs, switch to another active
// assistant's name and phone, or clear both so patients aren't sent to someone
// who's gone.
export async function releaseAssistantPhone(doctorId, assistantId) {
  const [doctor, leaving] = await Promise.all([
    User.findById(doctorId).select("assistantPhone").lean(),
    User.findById(assistantId).select("phone").lean(),
  ]);
  if (!samePhone(doctor?.assistantPhone, leaving?.phone)) return;
  const others = await Engagement.find({ doctor: doctorId, status: "active", assistant: { $ne: assistantId } })
    .sort({ startedAt: 1 })
    .populate("assistant", "name phone")
    .lean();
  const next = others.map((e) => e.assistant).find((a) => a?.phone && toChatId(a.phone));
  await User.updateOne(
    { _id: doctorId },
    { $set: { assistantPhone: next ? String(next.phone).trim() : "", assistantName: next ? String(next.name || "").trim() : "" } }
  );
}
