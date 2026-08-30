import express from "express";
import mongoose from "mongoose";
import Treatment from "../models/Treatment.js";
import User from "../models/User.js";
import { protect, clinicId } from "../middleware/auth.js";
import { notifyClinic, notifyPatient, notifyUser } from "../utils/notify.js";

const router = express.Router();
router.use(protect);

const isStaff = (user) => user.role === "doctor" || user.role === "assistant";

const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

// Tidy free-text so careless casing doesn't reach the record. We only uppercase
// the FIRST letter of words (never lowercase the rest) so acronyms like "OPG",
// "TMJ" or "X-ray" are preserved. Procedures get each word capitalised (e.g.
// "root canal" -> "Root Canal"); diagnosis/notes get just the first letter.
const clean = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const capWords = (s) => clean(s).replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const capFirst = (s) => {
  const t = clean(s);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

// Notify the patient (in-app + push + email) that a payment was collected.
// Fire-and-forget: never block or fail the payment request on a notify error.
async function notifyPaymentReceived(tr, amount, actor) {
  try {
    if (!amount || amount <= 0) return;
    const doctor = await User.findById(tr.doctor).select("name").catch(() => null);
    const drName = doctor?.name ? `Dr. ${doctor.name}` : "your doctor";
    const settled = tr.balance <= 0;

    // Patient notification.
    const body =
      `Payment received: ${money(amount)} for your ${tr.procedure} with ${drName}. ` +
      (settled
        ? "Your balance is now fully cleared — thank you!"
        : `Remaining balance: ${money(tr.balance)}.`);
    await notifyPatient(tr.client, {
      type: "payment_received",
      title: "Payment received",
      body,
      url: "/client/treatments",
    });

    // When an ASSISTANT collected the payment, notify the doctor (clinic owner)
    // so he's aware of money collected on his behalf.
    if (actor?.role === "assistant" && String(actor._id) !== String(tr.doctor)) {
      const patient = await User.findById(tr.client).select("name").catch(() => null);
      const patientName = patient?.name || "a patient";
      const staffBody =
        `${actor.name} collected ${money(amount)} from ${patientName} for ${tr.procedure}. ` +
        (settled ? "Balance is now cleared." : `Remaining balance: ${money(tr.balance)}.`);
      await notifyUser(tr.doctor, {
        type: "payment_collected",
        title: "Payment collected",
        body: staffBody,
        url: `/clients/${tr.client}`,
      });
    }
  } catch (e) {
    console.error("[payment notify]", e?.message);
  }
}

// Map Mongoose optimistic-concurrency failures to a 409 so the client can refresh.
const handleErr = (res, err) => {
  if (err.name === "VersionError") {
    return res.status(409).json({
      message: "This record was just changed by someone else. Refresh and try again.",
      code: "STALE",
    });
  }
  console.error(err);
  res.status(500).json({ message: "Server error" });
};

// GET /api/treatments?client=<id>
// Clinic staff: all treatments for their clinic (optionally filter by client)
// Client: their own treatment history
router.get("/", async (req, res) => {
  const { client } = req.query;
  let filter;
  if (isStaff(req.user)) {
    filter = { doctor: clinicId(req.user), ...(client ? { client } : {}) };
  } else if (client && String(client) !== String(req.user._id)) {
    // A guardian may view a linked dependent's history.
    const dep = await User.findOne({ _id: client, managed: true, guardian: req.user._id }).select("_id");
    if (!dep) return res.status(403).json({ message: "Forbidden" });
    filter = { client: dep._id };
  } else {
    filter = { client: req.user._id };
  }

  const treatments = await Treatment.find(filter)
    .populate("client", "name email")
    .populate("doctor", "name email")
    .sort({ date: -1 });
  res.json(treatments);
});

// GET /api/treatments/outstanding  -> unpaid balance per patient for the clinic,
// as { clientId: total }. Used by the dashboard to show a balance on each slot.
// Must be declared before any "/:id" route so it isn't shadowed.
router.get("/outstanding", async (req, res) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ message: "Staff only" });
    const doctorId = new mongoose.Types.ObjectId(String(clinicId(req.user)));
    const rows = await Treatment.aggregate([
      { $match: { doctor: doctorId } },
      { $addFields: { paidAmount: { $sum: "$payments.amount" } } },
      { $addFields: { outstanding: { $subtract: [{ $ifNull: ["$cost", 0] }, "$paidAmount"] } } },
      { $match: { outstanding: { $gt: 0 } } },
      { $group: { _id: "$client", total: { $sum: "$outstanding" } } },
    ]);
    const map = {};
    for (const r of rows) map[String(r._id)] = Math.round(r.total);
    res.json(map);
  } catch (err) {
    handleErr(res, err);
  }
});

// POST /api/treatments/:id/follow-up  (patient/guardian) -> report a problem / recall.
// Logs the issue on the treatment and alerts the clinic (in-app + push).
router.post("/:id/follow-up", async (req, res) => {
  try {
    if (isStaff(req.user)) return res.status(403).json({ message: "Patients only" });
    const message = (req.body.message || "").toString().trim();
    if (!message) return res.status(400).json({ message: "Please describe the issue." });

    const tr = await Treatment.findById(req.params.id);
    if (!tr) return res.status(404).json({ message: "Treatment not found" });

    // Ownership: the patient themselves, or the guardian of a managed dependent.
    let patientName = req.user.name;
    if (String(tr.client) !== String(req.user._id)) {
      const dep = await User.findOne({
        _id: tr.client,
        managed: true,
        guardian: req.user._id,
      }).select("name");
      if (!dep) return res.status(403).json({ message: "Forbidden" });
      patientName = dep.name;
    }

    tr.followUps.push({ message, status: "open" });
    await tr.save();

    await notifyClinic(tr.doctor, {
      type: "treatment_followup",
      title: `${patientName} reported an issue`,
      body: `${tr.procedure}: ${message}`,
      url: `/clients/${tr.client}`,
    });

    res.status(201).json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// PUT /api/treatments/:id/follow-up/:fid/resolve  (staff) -> mark a report handled.
router.put("/:id/follow-up/:fid/resolve", async (req, res) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ message: "Staff only" });
    const tr = await Treatment.findOne({ _id: req.params.id, doctor: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    const f = tr.followUps.id(req.params.fid);
    if (!f) return res.status(404).json({ message: "Report not found" });
    f.status = "resolved";
    f.resolvedAt = new Date();
    await tr.save();
    res.json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// POST /api/treatments (doctor)
router.post("/", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can add treatments" });
    }
    const {
      client,
      appointment,
      procedure,
      toothNumber,
      diagnosis,
      description,
      prescription,
      cost,
      upfront,
      upfrontMethod,
      date,
    } = req.body;
    if (!client || !procedure) {
      return res.status(400).json({ message: "client and procedure are required" });
    }
    // Normalise casing so careless entry doesn't reach the record.
    const procedureClean = capWords(procedure);
    const diagnosisClean = capFirst(diagnosis);
    const descriptionClean = capFirst(description);
    const prescriptionClean = capFirst(prescription);
    const total = Number(cost) || 0;
    const deposit = Number(upfront) || 0;
    if (deposit > 0 && !["cash", "online"].includes(upfrontMethod)) {
      return res.status(400).json({ message: "Select how the upfront payment was collected (cash or online)." });
    }
    const payments =
      deposit > 0 ? [{ amount: deposit, note: "Upfront", method: upfrontMethod }] : [];

    // Duplicate guard. Two failure modes:
    //  (a) a rapid double-submit / network retry from ONE device, and
    //  (b) two staff (doctor + assistant, on separate phones) both recording the
    //      SAME treatment for a patient without seeing the other's entry.
    // We look for an existing treatment for this patient with the same procedure,
    // cost and tooth ON THE SAME DAY. A very recent match is a retry (return it
    // silently); an older match is likely a real duplicate, so we ask the staff to
    // confirm (409) — and only add it if they resend with force:true.
    const force = req.body.force === true;
    const base = date ? new Date(date) : new Date();
    const dayStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const existing = await Treatment.findOne({
      doctor: clinicId(req.user),
      client,
      procedure: procedureClean,
      cost: total,
      toothNumber: toothNumber ?? null,
      date: { $gte: dayStart, $lt: dayEnd },
    }).sort({ createdAt: -1 });
    if (existing) {
      if (Date.now() - new Date(existing.createdAt).getTime() < 15000) {
        return res.status(201).json(existing); // retry / double-submit
      }
      if (!force) {
        return res.status(409).json({
          message: "A matching treatment for this patient is already recorded today.",
          code: "DUP_TREATMENT",
        });
      }
    }

    const tr = await Treatment.create({
      doctor: clinicId(req.user),
      client,
      appointment,
      procedure: procedureClean,
      toothNumber,
      diagnosis: diagnosisClean,
      description: descriptionClean,
      prescription: prescriptionClean,
      cost: total,
      payments,
      paid: deposit >= total && total > 0,
      date,
    });
    if (deposit > 0) notifyPaymentReceived(tr, deposit, req.user); // fire-and-forget
    res.status(201).json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// PUT /api/treatments/:id  (edit fields; paid:true settles the remaining balance)
router.put("/:id", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can update treatments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, doctor: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    if (req.body.version !== undefined && Number(req.body.version) !== tr.__v) {
      return res.status(409).json({
        message: "This treatment was just changed by someone else. Refresh and try again.",
        code: "STALE",
      });
    }

    const editable = ["procedure", "toothNumber", "diagnosis", "description", "date"];
    for (const f of editable) if (req.body[f] !== undefined) tr[f] = req.body[f];
    // Normalise casing on edit too (procedure -> Each Word, others -> First letter).
    if (req.body.procedure !== undefined) tr.procedure = capWords(req.body.procedure);
    if (req.body.diagnosis !== undefined) tr.diagnosis = capFirst(req.body.diagnosis);
    if (req.body.description !== undefined) tr.description = capFirst(req.body.description);
    if (req.body.prescription !== undefined) tr.prescription = capFirst(req.body.prescription);
    if (req.body.cost !== undefined) tr.cost = Number(req.body.cost) || 0;

    // Track how much new money was collected in this edit, so we can notify the
    // patient (only for money coming IN, not a downward correction).
    let collectedNow = 0;

    // Edit total collected: reconcile to the target by appending a single
    // "Adjustment" entry (positive or negative) so existing payments are never
    // rewritten and the change is visible in the payment history.
    if (req.body.collected !== undefined) {
      const target = Number(req.body.collected);
      if (Number.isNaN(target) || target < 0) {
        return res.status(400).json({ message: "Collected amount must be zero or more." });
      }
      if (target > tr.cost) {
        return res.status(400).json({ message: "Collected amount cannot exceed the charges." });
      }
      const delta = Math.round((target - tr.paidAmount) * 100) / 100;
      if (delta !== 0) {
        tr.payments.push({ amount: delta, note: "Adjustment", date: new Date() });
      }
      if (delta > 0) collectedNow += delta;
    }

    // paid:true -> record a settlement payment for whatever balance remains
    if (req.body.paid === true && tr.balance > 0) {
      const settleAmount = tr.balance;
      tr.payments.push({ amount: settleAmount, note: "Settled" });
      collectedNow += settleAmount;
    }
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;

    await tr.save();
    if (collectedNow > 0) notifyPaymentReceived(tr, collectedNow, req.user); // fire-and-forget
    res.json(tr);
  } catch (err) {
    if (err.name === "VersionError") {
      return res.status(409).json({
        message: "This treatment was just changed by someone else. Refresh and try again.",
        code: "STALE",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/treatments/:id/payments  (record a per-visit payment)
router.post("/:id/payments", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can record payments" });
    }
    const amount = Number(req.body.amount);
    // Allow a Rs 0 entry (e.g. logging a visit where nothing was collected).
    if (Number.isNaN(amount) || amount < 0) {
      return res.status(400).json({ message: "A valid amount is required" });
    }
    const { method } = req.body;
    // A payment method only matters when money actually changed hands.
    if (amount > 0 && !["cash", "online"].includes(method)) {
      return res.status(400).json({ message: "Select how the payment was collected (cash or online)." });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, doctor: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });

    if (amount > tr.balance) {
      return res
        .status(400)
        .json({ message: `Amount cannot exceed the remaining balance (${tr.balance}).` });
    }

    tr.payments.push({ amount, note: req.body.note, method, date: req.body.date || new Date() });
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    if (amount > 0) notifyPaymentReceived(tr, amount, req.user); // fire-and-forget; skip for a 0 log
    res.status(201).json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// PUT /api/treatments/:id/payments/:paymentId  (edit a recorded payment)
router.put("/:id/payments/:paymentId", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can edit payments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, doctor: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    const pay = tr.payments.id(req.params.paymentId);
    if (!pay) return res.status(404).json({ message: "Payment not found" });

    if (req.body.amount !== undefined) {
      const amount = Number(req.body.amount);
      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "A positive amount is required" });
      }
      // The other payments plus this new amount must not exceed the treatment cost.
      const others = tr.paidAmount - pay.amount;
      if (tr.cost > 0 && others + amount > tr.cost) {
        return res
          .status(400)
          .json({ message: `Amount cannot exceed the remaining balance (${tr.cost - others}).` });
      }
      pay.amount = amount;
    }
    if (req.body.note !== undefined) pay.note = req.body.note;
    if (req.body.date !== undefined) pay.date = req.body.date;
    if (req.body.method !== undefined) {
      if (!["cash", "online"].includes(req.body.method)) {
        return res.status(400).json({ message: "Method must be cash or online." });
      }
      pay.method = req.body.method;
    }

    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    res.json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// DELETE /api/treatments/:id/payments/:paymentId  (remove a recorded payment)
router.delete("/:id/payments/:paymentId", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can delete payments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, doctor: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    const pay = tr.payments.id(req.params.paymentId);
    if (!pay) return res.status(404).json({ message: "Payment not found" });

    pay.deleteOne();
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    res.json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// DELETE /api/treatments/:id
router.delete("/:id", async (req, res) => {
  if (!isStaff(req.user)) {
    return res.status(403).json({ message: "Only clinic staff can delete treatments" });
  }
  const tr = await Treatment.findOneAndDelete({
    _id: req.params.id,
    doctor: clinicId(req.user),
  });
  if (!tr) return res.status(404).json({ message: "Treatment not found" });
  res.json({ message: "Deleted" });
});

export default router;
