import express from "express";
import { runRemindersOnce } from "../jobs/reminders.js";
import { runBalanceRemindersOnce } from "../jobs/balanceReminders.js";
import { generateInvoicesOnce } from "../jobs/invoices.js";

const router = express.Router();

const authed = (req) => {
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  return process.env.CRON_SECRET && provided === process.env.CRON_SECRET;
};

// POST/GET /api/cron/run-reminders  -> triggered by an external scheduler.
// Authenticated with a shared secret (header x-cron-secret or ?secret=...),
// NOT the user JWT — so a cron service can call it.
const handler = async (req, res) => {
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    // Appointment reminders + 15-day outstanding-balance reminders on the same
    // external schedule (each is self-gated so it only sends when actually due).
    const sent = await runRemindersOnce();
    const balanceRemindersSent = await runBalanceRemindersOnce();
    res.json({ ok: true, sent, balanceRemindersSent });
  } catch (err) {
    console.error("[cron] reminder run failed:", err?.message);
    res.status(500).json({ message: "Server error" });
  }
};

router.get("/run-reminders", handler);
router.post("/run-reminders", handler);

// Generate any due monthly subscription invoices (safe to call daily; the job
// only creates invoices from the 5th onward and never duplicates a month).
const invoicesHandler = async (req, res) => {
  if (!authed(req)) return res.status(401).json({ message: "Unauthorized" });
  try {
    const created = await generateInvoicesOnce();
    res.json({ ok: true, created });
  } catch (err) {
    console.error("[cron] invoice run failed:", err?.message);
    res.status(500).json({ message: "Server error" });
  }
};
router.get("/generate-invoices", invoicesHandler);
router.post("/generate-invoices", invoicesHandler);

export default router;
