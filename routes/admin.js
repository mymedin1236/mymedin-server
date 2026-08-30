import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import LoginEvent from "../models/LoginEvent.js";
import Invoice from "../models/Invoice.js";
import { generateInvoicesOnce, DEFAULT_MONTHLY_FEE } from "../jobs/invoices.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Admin-only across the board.
router.use(protect, requireRole("admin"));

// GET /api/admin/logins?hours=24&success=all|true|false&limit=500
// Recent login activity, newest first.
router.get("/logins", async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const filter = { createdAt: { $gte: since } };
    if (req.query.success === "true") filter.success = true;
    else if (req.query.success === "false") filter.success = false;

    const events = await LoginEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ since, hours, count: events.length, events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/admin/logins/:id -> remove a single login record.
router.delete("/logins/:id", async (req, res) => {
  try {
    const deleted = await LoginEvent.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Record not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/admin/logins?olderThanDays=30  -> bulk delete (all if no param).
router.delete("/logins", async (req, res) => {
  try {
    const days = Number(req.query.olderThanDays);
    const filter =
      days > 0 ? { createdAt: { $lt: new Date(Date.now() - days * 86400000) } } : {};
    const r = await LoginEvent.deleteMany(filter);
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/admin/summary?hours=24 -> headline numbers for the dashboard.
router.get("/summary", async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [successes, failures, uniqueUsers, byRoleAgg, totalUsers, usersByRoleAgg, pwaLogins] =
      await Promise.all([
        LoginEvent.countDocuments({ createdAt: { $gte: since }, success: true }),
        LoginEvent.countDocuments({ createdAt: { $gte: since }, success: false }),
        LoginEvent.distinct("user", { createdAt: { $gte: since }, success: true }),
        LoginEvent.aggregate([
          { $match: { createdAt: { $gte: since }, success: true } },
          { $group: { _id: "$role", count: { $sum: 1 } } },
        ]),
        User.countDocuments({}),
        User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
        LoginEvent.countDocuments({ createdAt: { $gte: since }, success: true, pwa: true }),
      ]);

    const toMap = (arr) => arr.reduce((m, r) => ({ ...m, [r._id || "unknown"]: r.count }), {});
    res.json({
      hours,
      since,
      logins: { success: successes, failed: failures, uniqueUsers: uniqueUsers.length, pwa: pwaLogins },
      loginsByRole: toMap(byRoleAgg),
      totalUsers,
      usersByRole: toMap(usersByRoleAgg),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/admin/users?role=&search=&limit= -> user directory.
router.get("/users", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    // PWA usage: "installed" = last opened via the installed app; "not" = last
    // opened in a browser or never seen (candidates to nudge to install).
    if (req.query.pwa === "installed") filter.lastLoginPwa = true;
    else if (req.query.pwa === "not") filter.lastLoginPwa = { $ne: true };
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { clinicName: rx }];
    }
    const users = await User.find(filter)
      .select("name email phone role clinicName managed lastLoginPwa createdAt")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: users.length, users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/admin/enrollments -> every clinic (dentist) with its e-agreement
// status: enrollment date, discovery-end (sign date + 3 months), and phase.
router.get("/enrollments", async (req, res) => {
  try {
    const dentists = await User.find({ role: "dentist" })
      .select("name clinicName email phone agreement billing createdAt")
      .sort({ createdAt: -1 })
      .lean();
    const now = Date.now();
    const clinics = dentists.map((d) => {
      const acceptedAt = d.agreement?.acceptedAt || null;
      let discoveryEnd = null;
      let phase = "not_signed";
      if (acceptedAt) {
        const de = new Date(acceptedAt);
        de.setMonth(de.getMonth() + 3);
        discoveryEnd = de;
        phase = now < de.getTime() ? "discovery" : "paid";
      }
      return {
        _id: d._id,
        name: d.name,
        clinicName: d.clinicName || "",
        email: d.email || "",
        phone: d.phone || "",
        signedName: d.agreement?.name || null,
        acceptedAt,
        discoveryEnd,
        phase, // not_signed | discovery | paid
        billing: {
          startMonth: d.billing?.startMonth || "",
          monthlyFee: d.billing?.monthlyFee ?? null,
        },
        createdAt: d.createdAt,
      };
    });
    res.json({ count: clinics.length, clinics });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// "View as" — mint a short-lived, read-only token so an admin can observe a
// dentist's exact view without their (hashed, unrecoverable) password. The token
// carries { readOnly: true }, which the global guard uses to block every write.
router.post("/impersonate/:dentistId", async (req, res) => {
  try {
    const dentist = await User.findOne({
      _id: req.params.dentistId,
      role: "dentist",
    }).select("_id name clinicName email");
    if (!dentist) return res.status(404).json({ message: "Dentist not found" });

    const token = jwt.sign(
      {
        id: String(dentist._id),
        role: "dentist",
        readOnly: true,
        impersonatedBy: String(req.user._id),
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    // Audit trail: who viewed whom (auto-expires with the login-event TTL).
    LoginEvent.create({
      user: dentist._id,
      name: dentist.name,
      identifier: dentist.email || "",
      role: "dentist",
      success: true,
      reason: `read-only view by admin ${req.user.email || req.user._id}`,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || "",
    }).catch(() => {});
    console.log(`[impersonate] admin ${req.user._id} -> dentist ${dentist._id} (read-only)`);

    const base =
      (process.env.CLIENT_ORIGIN || "").split(",")[0].trim() || "http://localhost:5173";
    const label = dentist.clinicName || dentist.name || "clinic";
    const url = `${base}/impersonate#token=${token}&name=${encodeURIComponent(label)}`;

    res.json({
      token,
      url,
      dentist: { _id: dentist._id, name: dentist.name, clinicName: dentist.clinicName || "" },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---- Subscription invoices ------------------------------------------------

// Set (or clear) a clinic's billing start month + optional fee override.
router.put("/dentists/:id/billing", async (req, res) => {
  try {
    const d = await User.findOne({ _id: req.params.id, role: "dentist" });
    if (!d) return res.status(404).json({ message: "Dentist not found" });
    const { startMonth, monthlyFee } = req.body;
    if (startMonth !== undefined && startMonth && !/^\d{4}-\d{2}$/.test(startMonth)) {
      return res.status(400).json({ message: "startMonth must be YYYY-MM" });
    }
    d.billing = d.billing || {};
    if (startMonth !== undefined) d.billing.startMonth = startMonth || undefined;
    if (monthlyFee !== undefined) {
      d.billing.monthlyFee = monthlyFee === "" || monthlyFee == null ? undefined : Number(monthlyFee);
    }
    d.markModified("billing");
    await d.save();
    res.json({ _id: d._id, billing: d.billing });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Generate any due-but-missing invoices right now (idempotent).
router.post("/invoices/generate", async (req, res) => {
  try {
    const created = await generateInvoicesOnce();
    res.json({ created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// All invoices, newest month first.
router.get("/invoices", async (req, res) => {
  try {
    const invoices = await Invoice.find()
      .populate("dentist", "name clinicName email billing")
      .sort({ month: -1, createdAt: -1 });
    res.json({ count: invoices.length, defaultFee: DEFAULT_MONTHLY_FEE, invoices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Mark an invoice paid / unpaid (and optional note).
router.patch("/invoices/:id", async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const { status, note } = req.body;
    if (status === "paid") {
      inv.status = "paid";
      inv.paidAt = new Date();
      inv.markedBy = req.user._id;
    } else if (status === "unpaid") {
      inv.status = "unpaid";
      inv.paidAt = undefined;
      inv.markedBy = undefined;
    }
    if (note !== undefined) inv.note = note;
    await inv.save();
    res.json(inv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
