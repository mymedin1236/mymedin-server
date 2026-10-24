import User from "../models/User.js";
import Engagement from "../models/Engagement.js";
import { toChatId } from "./whatsapp.js";

// Keeps the doctor's `assistantPhone` (the "Assistant to doctor" line in patient
// WhatsApp messages, editable in Settings) in step with the clinic's staff.

// An assistant joined: use their phone if the clinic hasn't set a number yet.
// A number the doctor typed in Settings is never overwritten.
export async function fillAssistantPhone(doctorId, assistant) {
  const phone = String(assistant?.phone || "").trim();
  if (!phone || !toChatId(phone)) return;
  await User.updateOne(
    { _id: doctorId, $or: [{ assistantPhone: { $exists: false } }, { assistantPhone: "" }] },
    { $set: { assistantPhone: phone } }
  );
}

// An assistant left: if the clinic's number is theirs, switch to another active
// assistant's phone, or clear it so patients aren't sent to someone who's gone.
export async function releaseAssistantPhone(doctorId, assistantId) {
  const [doctor, leaving] = await Promise.all([
    User.findById(doctorId).select("assistantPhone").lean(),
    User.findById(assistantId).select("phone").lean(),
  ]);
  if (!doctor?.assistantPhone || !leaving?.phone || toChatId(doctor.assistantPhone) !== toChatId(leaving.phone)) {
    return;
  }
  const others = await Engagement.find({ doctor: doctorId, status: "active", assistant: { $ne: assistantId } })
    .sort({ startedAt: 1 })
    .populate("assistant", "phone")
    .lean();
  const next = others.map((e) => String(e.assistant?.phone || "").trim()).find((p) => p && toChatId(p)) || "";
  await User.updateOne({ _id: doctorId }, { $set: { assistantPhone: next } });
}
