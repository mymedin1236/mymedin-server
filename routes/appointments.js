import express from "express";
import mongoose from "mongoose";
import Appointment from "../models/Appointment.js";
import AppointmentType from "../models/AppointmentType.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { slotsForDay, findSlotAt, DEFAULT_SLOT_MINUTES } from "../utils/slots.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";
import { protect, resolveClinic, clinicId } from "../middleware/auth.js";
import { notifyClinic } from "../utils/notify.js";

const router = express.Router();
router.use(protect, resolveClinic);

const isStaff = (user) => user.role === "doctor" || user.role === "assistant";

// Format an appointment time in the clinic's timezone (server runs in UTC),
// so notifications/emails show local time, not UTC.
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";
const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: CLINIC_TZ,
  });

// Assistants act on behalf of their doctor — resolve the doctor's display name.
const doctorNameFor = async (user) => {
  if (user.role === "assistant") {
    const d = await User.findById(user.doctor).select("name");
    return d?.name || "your doctor";
  }
  return user.name;
};

// Statuses that actually hold a slot.
const ACTIVE = ["scheduled", "pending"];

// The longest an appointment can be (matches the AppointmentType `duration`
// cap), used to bound the overlap scan below.
const MAX_APPOINTMENT_MINUTES = 480;

// Everything the slot engine needs for one clinic, in a single round trip.
const clinicSchedule = async (doctorId) => {
  const [owner, types] = await Promise.all([
    User.findById(doctorId).select("availability slotDuration dayOverrides").lean(),
    AppointmentType.find({ doctor: doctorId }).sort({ order: 1, createdAt: 1 }).lean(),
  ]);
  return {
    availability: owner?.availability || [],
    dayOverrides: owner?.dayOverrides || [],
    defaultDuration: owner?.slotDuration || DEFAULT_SLOT_MINUTES,
    types: types || [],
    exists: !!owner,
  };
};

// A slot is taken when another active appointment for this doctor OVERLAPS the
// requested interval [date, date + duration). Since appointment types have
// different lengths, "overlap" is real interval arithmetic, not a fixed gap: a
// 90-minute transplant at 18:00 blocks 18:00-19:30 outright, while two adjacent
// 20-minute consultations at 12:00 and 12:20 sit happily side by side.
//
// The stored `duration` is the one snapshotted at booking time; appointments
// created before types existed have none, so they fall back to the clinic's
// default slot length. The exact-time unique index stays as the race-proof
// backstop underneath this check.
const slotConflict = async (doctorId, date, duration, exceptId) => {
  const owner = await User.findById(doctorId).select("slotDuration").lean();
  const fallback = owner?.slotDuration || DEFAULT_SLOT_MINUTES;
  const startMs = new Date(date).getTime();
  const endMs = startMs + (Number(duration) || fallback) * 60000;

  const query = {
    doctor: doctorId,
    status: { $in: ACTIVE },
    // Indexed pre-filter on the { doctor, date } index: an appointment can only
    // overlap us if it starts before we end and no earlier than the longest
    // possible appointment before we start. The $expr below then does the exact
    // arithmetic on the few candidates this leaves.
    date: { $gt: new Date(startMs - MAX_APPOINTMENT_MINUTES * 60000), $lt: new Date(endMs) },
    // ...and it overlaps only if its own end runs past our start.
    $expr: {
      $gt: [
        { $add: ["$date", { $multiply: [{ $ifNull: ["$duration", fallback] }, 60000] }] },
        new Date(startMs),
      ],
    },
  };
  if (exceptId) query._id = { $ne: exceptId };
  return Appointment.findOne(query);
};

// ---- Clinic-timezone slot validation (mirrors the client's slot logic) ----
// The clinic runs in Pakistan time (UTC+5, no DST). We validate a requested time
// IN THAT TIMEZONE so a crafted request can't book outside the clinic's opening
// hours or off the slot grid, no matter what the client sends.
const CLINIC_OFFSET_MIN = 5 * 60;
const pad2 = (n) => String(n).padStart(2, "0");
const clinicPartsOf = (date) => {
  const s = new Date(new Date(date).getTime() + CLINIC_OFFSET_MIN * 60000);
  return {
    dayStr: `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`,
    dow: s.getUTCDay(),
    minutes: s.getUTCHours() * 60 + s.getUTCMinutes(),
  };
};
// Resolve a requested instant against the clinic's real slot grid.
//
// Returns { slot } when the time is a genuine slot start — the slot carries the
// appointment type and its duration, which the caller snapshots onto the
// booking. Returns { error } when the clinic is closed, the time falls outside
// the operational-hours brackets, or it doesn't line up with any slot in the
// bracket it lands in (e.g. 18:45 inside an 18:00-21:00 / 90-minute transplant
// bracket, where only 18:00 and 19:30 are real starts).
//
// `wantedTypeId` disambiguates when two brackets of different types start at the
// same minute; without it the earliest-listed type wins.
const resolveSlot = async (doctorId, date, wantedTypeId) => {
  const schedule = await clinicSchedule(doctorId);
  if (!schedule.exists) return { slot: null }; // nothing to validate against

  const { dayStr, dow, minutes } = clinicPartsOf(date);
  const slots = slotsForDay({
    availability: schedule.availability,
    dayOverrides: schedule.dayOverrides,
    dayStr,
    dow,
    types: schedule.types,
    defaultDuration: schedule.defaultDuration,
  });

  if (!slots || slots.length === 0) return { error: "The clinic is closed on this day." };

  const slot = findSlotAt(slots, minutes, wantedTypeId);
  if (!slot) {
    const inHours = slots.some((sl) => minutes >= sl.start && minutes < sl.end);
    return {
      error: inHours
        ? "That time isn't the start of an appointment slot. Please pick one of the times shown."
        : "That time is outside the clinic's opening hours.",
    };
  }
  return { slot };
};

// The type + duration to stamp on a booking clinic STAFF are creating.
//
// Staff are deliberately not held to the patient-facing grid — they routinely
// squeeze someone in off-grid or after hours. So we take the slot's type when
// the time happens to land on one, honour an explicitly chosen type otherwise,
// and fall back to the clinic default. Only patients get a hard rejection.
const staffSlotFor = async (doctorId, date, wantedTypeId) => {
  const schedule = await clinicSchedule(doctorId);
  if (wantedTypeId) {
    const t = schedule.types.find((x) => String(x._id) === String(wantedTypeId));
    if (t) return { appointmentType: t._id, typeName: t.name, duration: t.duration };
  }
  const { slot } = await resolveSlot(doctorId, date, wantedTypeId);
  if (slot) {
    return {
      appointmentType: slot.typeId || undefined,
      typeName: slot.typeName || "",
      duration: slot.duration,
    };
  }
  return { appointmentType: undefined, typeName: "", duration: schedule.defaultDuration };
};

// Calendar-day window [start, end) for the given instant.
const dayRange = (date) => {
  const d = new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

// True if the patient already has an active (scheduled/pending) appointment that day.
// One appointment per patient per day keeps the schedule sane.
const patientDayConflict = async (clientId, date, exceptId) => {
  const { start, end } = dayRange(date);
  const query = { client: clientId, status: { $in: ACTIVE }, date: { $gte: start, $lt: end } };
  if (exceptId) query._id = { $ne: exceptId };
  return Appointment.findOne(query);
};

// A patient owns an appointment if it's theirs, or it's for a dependent they manage.
const clientOwnsAppt = async (userId, appt) => {
  if (String(appt.client) === String(userId)) return true;
  return !!(await User.exists({ _id: appt.client, managed: true, guardian: userId }));
};

// Notify a user in-app + push + (optionally) email.
// Where a patient's notification should go. For a managed dependent, route to the
// linked guardian's account (in-app + push) and the guardian's email.
const clientNotifyTarget = (c) => ({
  userId: c.managed ? c.guardian || null : c._id,
  email: c.managed
    ? c.guardianEmail
      ? { to: c.guardianEmail, greeting: `Hi ${c.guardianName || "there"},\n\n` }
      : null
    : c.email
    ? { to: c.email, greeting: `Hi ${c.name},\n\n` }
    : null,
});

const notifyUser = async (userId, { type, title, body, url, email, data }) => {
  if (userId) {
    let ack;
    try {
      const n = await Notification.create({ user: userId, type, title, body, data: { url, ...data } });
      if (data?.canAcknowledge) ack = String(n._id); // lets the push carry an Acknowledge action
    } catch (e) {
      console.error("notif failed:", e?.message);
    }
    sendPush(userId, ack ? { title, body, url, ack } : { title, body, url });
  }
  if (email?.to) {
    const text = `${email.greeting || ""}${body}`;
    sendMail({ to: email.to, subject: title, text, html: text.replace(/\n/g, "<br/>") }).catch(
      (e) => console.error("email failed:", e?.message)
    );
  }
};

// GET /api/appointments
// Doctor: appointments where they are the doctor
// Client: appointments where they are the client
router.get("/", async (req, res) => {
  let filter;
  if (isStaff(req.user)) {
    filter = { doctor: clinicId(req.user) };
  } else {
    // A patient sees their own appointments plus those of their dependents.
    const deps = await User.find({ managed: true, guardian: req.user._id }).select("_id");
    filter = { client: { $in: [req.user._id, ...deps.map((d) => d._id)] } };
  }
  const appts = await Appointment.find(filter)
    .populate("client", "name email phone")
    .populate("doctor", "name email clinicName location")
    .sort({ date: -1 });
  res.json(appts);
});

// GET /api/appointments/booked?from=ISO&to=ISO&exclude=<id>
// Returns the datetimes of scheduled appointments for the relevant clinic within
// [from, to), so the UI can show which slots are taken. Scoped by role:
// staff -> their clinic; client -> their associated doctor.
router.get("/booked", async (req, res) => {
  try {
    const doctorId = isStaff(req.user)
      ? clinicId(req.user)
      : req.user.role === "client"
      ? req.user.doctor
      : null;
    if (!doctorId) return res.json({ slots: [] });

    const q = { doctor: doctorId, status: { $in: ACTIVE } };
    const { from, to, exclude } = req.query;
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lt = new Date(to);
    }
    if (exclude && mongoose.isValidObjectId(exclude)) q._id = { $ne: exclude };

    const [appts, schedule] = await Promise.all([
      Appointment.find(q).select("date duration appointmentType typeName").lean(),
      clinicSchedule(doctorId),
    ]);
    res.json({
      // `slots` (start times only) is kept for older clients; `booked` carries
      // each booking's length so the picker can grey out every slot an existing
      // appointment runs through, not just the one it starts on.
      slots: appts.map((a) => a.date),
      booked: appts.map((a) => ({
        date: a.date,
        duration: a.duration || schedule.defaultDuration,
        appointmentType: a.appointmentType || null,
        typeName: a.typeName || "",
      })),
      availability: schedule.availability,
      slotDuration: schedule.defaultDuration,
      dayOverrides: schedule.dayOverrides,
      appointmentTypes: schedule.types,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/appointments (clinic staff create)
router.post("/", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can create appointments" });
    }
    const doctorId = clinicId(req.user);
    const { client, date, reason, notes, appointmentType } = req.body;
    if (!client || !date) {
      return res.status(400).json({ message: "client and date are required" });
    }
    if (new Date(date).getTime() < Date.now()) {
      return res.status(400).json({ message: "Appointment cannot be in the past" });
    }
    // Type + length for this booking, so the overlap check below reserves the
    // right amount of the doctor's day (20 minutes vs 90).
    const typing = await staffSlotFor(doctorId, date, appointmentType);
    if (await slotConflict(doctorId, date, typing.duration)) {
      return res.status(409).json({
        message: "Another appointment is already scheduled at this date and time.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(client, date)) {
      return res.status(409).json({
        message: "This patient already has an appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }
    const appt = await Appointment.create({
      doctor: doctorId,
      client,
      date,
      reason,
      notes,
      ...typing,
    });
    const populated = await appt.populate([
      { path: "client", select: "name email phone managed guardian guardianName guardianEmail guardianPhone" },
      { path: "doctor", select: "name email" },
    ]);

    // Notify the patient (or the guardian, for a managed child) + give staff a WhatsApp link
    const c = populated.client;
    const dName = await doctorNameFor(req.user);
    const when = fmtWhen(date);
    const whose = c.managed ? `${c.name}'s` : "your";
    const body = `Dr. ${dName} scheduled ${whose} appointment on ${when}${
      reason ? ` for ${reason}` : ""
    }.`;
    const t = clientNotifyTarget(c);
    await notifyUser(t.userId, {
      type: "appointment_scheduled",
      title: "Appointment scheduled",
      body,
      url: "/client",
      email: t.email,
      data: { appointmentId: populated._id, canAcknowledge: true },
    });

    const shareMessage = `Hi ${c.managed ? c.guardianName || "there" : c.name}, ${body}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;

    res.status(201).json({ appointment: populated, shareMessage, whatsappUrl });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "That slot was just taken — please pick another time.",
        code: "SLOT_TAKEN",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/appointments/request  (client requests an appointment with their doctor)
router.post("/request", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only patients can request appointments" });
    }
    const { date, reason } = req.body;
    if (!date) return res.status(400).json({ message: "Please pick a time slot." });
    if (new Date(date).getTime() < Date.now()) {
      return res.status(400).json({ message: "Appointment cannot be in the past" });
    }

    // Booking for self, or for a linked dependent (req.body.for = dependent id).
    let patientId = req.user._id;
    let patientName = req.user.name;
    let doctorId = req.user.doctor;
    if (req.body.for && String(req.body.for) !== String(req.user._id)) {
      const dep = await User.findOne({
        _id: req.body.for,
        managed: true,
        guardian: req.user._id,
      });
      if (!dep) return res.status(403).json({ message: "Not your dependent" });
      patientId = dep._id;
      patientName = dep.name;
      doctorId = dep.doctor;
    }
    if (!doctorId) {
      return res.status(400).json({ message: "You are not associated with a doctor yet." });
    }

    const { slot, error: badSlot } = await resolveSlot(doctorId, date, req.body.appointmentType);
    if (badSlot) return res.status(400).json({ message: badSlot, code: "INVALID_SLOT" });

    if (await slotConflict(doctorId, date, slot?.duration)) {
      return res.status(409).json({
        message: "That slot was just taken. Please pick another time.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(patientId, date)) {
      return res.status(409).json({
        message: `${patientName} already has an appointment on this day.`,
        code: "PATIENT_DAY_TAKEN",
      });
    }

    const appt = await Appointment.create({
      doctor: doctorId,
      client: patientId,
      date,
      reason,
      status: "pending",
      appointmentType: slot?.typeId || undefined,
      typeName: slot?.typeName || "",
      duration: slot?.duration,
    });

    const when = fmtWhen(date);
    const doctor = await User.findById(doctorId).select("name email");
    const body = `${patientName} requested an appointment on ${when}${
      reason ? ` for ${reason}` : ""
    }.`;
    await notifyClinic(doctorId, {
      type: "appointment_requested",
      title: "New appointment request",
      body,
      url: "/appointments",
      email: doctor?.email ? { to: doctor.email, greeting: `Hi Dr. ${doctor.name},\n\n` } : null,
    });

    res.status(201).json({ appointment: appt });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "That slot was just taken — please pick another time.",
        code: "SLOT_TAKEN",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/confirm  (staff approves a pending request)
router.patch("/:id/confirm", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can confirm requests" });
    }
    const doctorId = clinicId(req.user);
    const appt = await Appointment.findOne({ _id: req.params.id, doctor: doctorId, status: "pending" });
    if (!appt) return res.status(404).json({ message: "Request not found" });

    // Make sure the slot wasn't taken by someone else since the request came in.
    if (await slotConflict(doctorId, appt.date, appt.duration, appt._id)) {
      return res.status(409).json({
        message: "That slot is already taken — decline this request or reschedule.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(appt.client, appt.date, appt._id)) {
      return res.status(409).json({
        message: "This patient already has another appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    appt.status = "scheduled";
    appt.remind24hSent = false;
    appt.remind12hSent = false;
    appt.remind1hSent = false;
    await appt.save();
    const populated = await appt.populate([
      { path: "client", select: "name email phone managed guardian guardianName guardianEmail" },
      { path: "doctor", select: "name email" },
    ]);

    const c = populated.client;
    const dName = await doctorNameFor(req.user);
    const when = fmtWhen(appt.date);
    const whose = c.managed ? `${c.name}'s` : "your";
    const t = clientNotifyTarget(c);
    await notifyUser(t.userId, {
      type: "appointment_confirmed",
      title: "Appointment confirmed",
      body: `Dr. ${dName} confirmed ${whose} appointment on ${when}.`,
      url: "/client",
      email: t.email,
      data: { appointmentId: appt._id, canAcknowledge: true },
    });

    res.json(populated);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "That slot is already taken — decline this request or reschedule.",
        code: "SLOT_TAKEN",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/decline  (staff declines a pending request)
router.patch("/:id/decline", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can decline requests" });
    }
    const doctorId = clinicId(req.user);
    const appt = await Appointment.findOne({ _id: req.params.id, doctor: doctorId, status: "pending" });
    if (!appt) return res.status(404).json({ message: "Request not found" });

    appt.status = "cancelled";
    await appt.save();
    const populated = await appt.populate([
      { path: "client", select: "name email phone managed guardian guardianName guardianEmail" },
      { path: "doctor", select: "name email" },
    ]);

    const c = populated.client;
    const dName = await doctorNameFor(req.user);
    const when = fmtWhen(appt.date);
    const whose = c.managed ? `${c.name}'s` : "your";
    const t = clientNotifyTarget(c);
    await notifyUser(t.userId, {
      type: "appointment_declined",
      title: "Appointment request declined",
      body: `Dr. ${dName} could not confirm ${whose} requested appointment on ${when}. Please pick another time.`,
      url: "/client",
      email: t.email,
    });

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/appointments/:id  (clinic staff update)
router.put("/:id", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can update appointments" });
    }
    const doctorId = clinicId(req.user);
    const { date, reason, notes, status, version, appointmentType } = req.body;

    const current = await Appointment.findOne({ _id: req.params.id, doctor: doctorId });
    if (!current) return res.status(404).json({ message: "Appointment not found" });

    // Optimistic concurrency: reject if the record changed since the client loaded it.
    if (version !== undefined && Number(version) !== current.__v) {
      return res.status(409).json({
        message: "This appointment was just changed by someone else. Refresh to see the latest, then try again.",
        code: "STALE",
      });
    }

    const nextStatus = status ?? current.status;
    // Re-type the booking when staff MOVE it, or pick a different type for it —
    // sliding a booking from the consultation bracket into the transplant
    // bracket must also change how much of the day it reserves. An edit that
    // touches neither (renaming the reason, adding a note) leaves the type and
    // the duration snapshot exactly as booked.
    const movingDate =
      date !== undefined && new Date(date).getTime() !== new Date(current.date).getTime();
    const retypingType =
      appointmentType !== undefined &&
      String(appointmentType || "") !== String(current.appointmentType || "");
    const retype =
      movingDate || retypingType
        ? await staffSlotFor(
            doctorId,
            date ?? current.date,
            retypingType ? appointmentType : current.appointmentType
          )
        : null;
    const nextDuration = retype ? retype.duration : current.duration;

    if (date && nextStatus === "scheduled" && (await slotConflict(doctorId, date, nextDuration, current._id))) {
      return res.status(409).json({
        message: "Another appointment is already scheduled at this date and time.",
        code: "SLOT_TAKEN",
      });
    }
    if (date && ACTIVE.includes(nextStatus) && (await patientDayConflict(current.client, date, current._id))) {
      return res.status(409).json({
        message: "This patient already has an appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    const dateChanged = movingDate;

    const set = {};
    if (date !== undefined) set.date = date;
    if (retype) {
      set.appointmentType = retype.appointmentType || null;
      set.typeName = retype.typeName;
      set.duration = retype.duration;
    }
    if (reason !== undefined) set.reason = reason;
    if (notes !== undefined) set.notes = notes;
    if (status !== undefined) set.status = status;
    // Moving the time re-arms the 24h/12h/1h reminders and clears travel status,
    // so a rescheduled appointment notifies the patient for its NEW time.
    if (dateChanged) {
      set.remind24hSent = false;
      set.remind12hSent = false;
      set.remind1hSent = false;
      set.arrivalStatus = "none";
      set.arrivedAt = null;
    }

    // Guard the write with the version we validated, bumping it atomically.
    const appt = await Appointment.findOneAndUpdate(
      { _id: current._id, doctor: doctorId, __v: current.__v },
      { $set: set, $inc: { __v: 1 } },
      { new: true }
    )
      .populate("client", "name email phone managed guardian guardianName guardianEmail")
      .populate("doctor", "name email");
    if (!appt) {
      return res.status(409).json({
        message: "This appointment was just changed by someone else. Refresh and try again.",
        code: "STALE",
      });
    }

    // Tell the patient (or guardian, for a managed child) when staff move the time.
    if (dateChanged && appt.status === "scheduled") {
      const c = appt.client;
      const dName = await doctorNameFor(req.user);
      const whose = c.managed ? `${c.name}'s` : "your";
      const t = clientNotifyTarget(c);
      await notifyUser(t.userId, {
        type: "appointment_scheduled",
        title: "Appointment rescheduled",
        body: `Dr. ${dName} rescheduled ${whose} appointment to ${fmtWhen(appt.date)}.`,
        url: "/client",
        email: t.email,
      });
    }

    res.json(appt);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "That slot was just taken — please pick another time.",
        code: "SLOT_TAKEN",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/reschedule  (client moves their own appointment)
router.patch("/:id/reschedule", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only the client can reschedule" });
    }
    const { date } = req.body;
    if (!date) return res.status(400).json({ message: "New date is required" });
    if (new Date(date).getTime() < Date.now()) {
      return res.status(400).json({ message: "Appointment cannot be in the past" });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt || !(await clientOwnsAppt(req.user._id, appt))) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    if (!ACTIVE.includes(appt.status)) {
      return res.status(400).json({ message: "Only active appointments can be rescheduled." });
    }

    // A patient rescheduling stays within the grid, and lands on whatever type
    // the new bracket runs — moving from a consultation slot to a PRP slot
    // re-types the appointment (and its length) to match.
    const { slot, error: badSlot } = await resolveSlot(
      appt.doctor,
      date,
      req.body.appointmentType ?? appt.appointmentType
    );
    if (badSlot) return res.status(400).json({ message: badSlot, code: "INVALID_SLOT" });

    if (await slotConflict(appt.doctor, date, slot?.duration ?? appt.duration, appt._id)) {
      return res.status(409).json({
        message: "That slot is already taken. Please pick a different time.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(req.user._id, date, appt._id)) {
      return res.status(409).json({
        message: "You already have another appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    // Keep the current status — a pending request stays pending (awaiting
    // confirmation) at the new time; a scheduled one stays scheduled.
    appt.date = date;
    if (slot) {
      appt.appointmentType = slot.typeId || undefined;
      appt.typeName = slot.typeName || "";
      appt.duration = slot.duration;
    }
    appt.arrivalStatus = "none"; // moved time → clear travel status
    appt.remind24hSent = false; // re-arm reminders for the new time
    appt.remind12hSent = false;
    appt.remind1hSent = false;
    await appt.save();

    const populated = await appt.populate([
      { path: "doctor", select: "name email" },
      { path: "client", select: "name" },
    ]);
    const when = fmtWhen(date);
    const body =
      appt.status === "pending"
        ? `${populated.client.name} changed their requested appointment time to ${when}.`
        : `${populated.client.name} rescheduled their appointment to ${when}.`;

    await notifyClinic(populated.doctor._id, {
      type: "appointment_rescheduled",
      title: "Appointment rescheduled",
      body,
      url: "/appointments",
      email: populated.doctor.email
        ? { to: populated.doctor.email, greeting: `Hi Dr. ${populated.doctor.name},\n\n` }
        : null,
    });

    res.json(populated);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "That slot was just taken — please pick another time.",
        code: "SLOT_TAKEN",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/cancel  (client cancels their own active appointment)
router.patch("/:id/cancel", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only the patient can cancel their appointment" });
    }
    const appt = await Appointment.findById(req.params.id);
    if (!appt || !(await clientOwnsAppt(req.user._id, appt))) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    if (!ACTIVE.includes(appt.status)) {
      return res.status(400).json({ message: "This appointment can no longer be cancelled." });
    }

    const wasPending = appt.status === "pending";
    appt.status = "cancelled";
    await appt.save();

    const populated = await appt.populate([
      { path: "doctor", select: "name email" },
      { path: "client", select: "name" },
    ]);
    const when = fmtWhen(appt.date);
    const body = wasPending
      ? `${populated.client.name} withdrew their appointment request for ${when}.`
      : `${populated.client.name} cancelled their appointment on ${when}.`;

    await notifyClinic(populated.doctor._id, {
      type: "appointment_cancelled",
      title: "Appointment cancelled",
      body,
      url: "/appointments",
      email: populated.doctor.email
        ? { to: populated.doctor.email, greeting: `Hi Dr. ${populated.doctor.name},\n\n` }
        : null,
    });

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/arrival
// The patient signals they're on the way / arrived; OR clinic staff (doctor or
// assistant) mark a patient arrived on their behalf. Marking "arrived" stamps
// arrivedAt, which starts the waiting-time counter shown on the clinic's
// schedule (and, when the patient did it, on the patient's own screen).
router.patch("/:id/arrival", async (req, res) => {
  try {
    const staffActor = isStaff(req.user);
    // Staff may also reset to "none" (undo a mistaken mark); patients set only
    // on_the_way / arrived.
    const allowed = staffActor
      ? ["none", "on_the_way", "arrived"]
      : ["on_the_way", "arrived"];
    const { status } = req.body;
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid arrival status" });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ message: "Appointment not found" });

    // Authorize: staff act on their own clinic; patients on their own appointment.
    if (staffActor) {
      if (String(appt.doctor) !== String(clinicId(req.user))) {
        return res.status(404).json({ message: "Appointment not found" });
      }
    } else if (req.user.role === "client") {
      if (!(await clientOwnsAppt(req.user._id, appt))) {
        return res.status(404).json({ message: "Appointment not found" });
      }
    } else {
      return res.status(403).json({ message: "Not allowed to update arrival status" });
    }

    if (appt.status !== "scheduled") {
      return res.status(400).json({ message: "Only confirmed appointments can be updated." });
    }

    // Stamp arrivedAt the first time they're marked arrived (preserve it on
    // repeat calls); clear it whenever they're no longer "arrived".
    if (status === "arrived") {
      if (appt.arrivalStatus !== "arrived" || !appt.arrivedAt) appt.arrivedAt = new Date();
    } else {
      appt.arrivedAt = undefined;
    }
    appt.arrivalStatus = status;
    await appt.save();
    const populated = await appt.populate([
      { path: "doctor", select: "name email" },
      { path: "client", select: "name" },
    ]);

    // Only notify the clinic when the PATIENT reports in — staff marking a
    // patient arrived don't need to notify themselves.
    if (!staffActor && status !== "none") {
      const when = fmtWhen(appt.date);
      const body =
        status === "arrived"
          ? `${populated.client.name} has arrived at the clinic for their ${when} appointment.`
          : `${populated.client.name} is on the way to the clinic (appointment ${when}).`;
      await notifyClinic(populated.doctor._id, {
        type: "appointment_arrival",
        title: status === "arrived" ? "Patient has arrived" : "Patient on the way",
        body,
        url: "/appointments",
        email: populated.doctor.email
          ? { to: populated.doctor.email, greeting: `Hi Dr. ${populated.doctor.name},\n\n` }
          : null,
      });
    }

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/appointments/:id
router.delete("/:id", async (req, res) => {
  if (!isStaff(req.user)) {
    return res.status(403).json({ message: "Only clinic staff can delete appointments" });
  }
  const appt = await Appointment.findOneAndDelete({
    _id: req.params.id,
    doctor: clinicId(req.user),
  });
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  res.json({ message: "Deleted" });
});

export default router;
