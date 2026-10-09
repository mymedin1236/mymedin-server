import express from "express";
import { checkWhatsAppOnce } from "../jobs/whatsappWatch.js";

const router = express.Router();

// POST /api/webhooks/waha  -> WAHA "session.status" events, for instant
// WhatsApp-down alerts. Authenticated by a shared secret WAHA sends as a
// custom header (configured on the session by scripts/setupWahaWebhook.js).
router.post("/waha", async (req, res) => {
  const secret = process.env.WAHA_WEBHOOK_SECRET;
  if (!secret || req.headers["x-webhook-secret"] !== secret) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  res.json({ ok: true }); // ack fast; WAHA retries slow responses
  const { event, session, payload } = req.body || {};
  if (event !== "session.status" || session !== process.env.WAHA_SESSION) return;
  checkWhatsAppOnce(payload?.status).catch((e) => console.error("[waha webhook]", e?.message));
});

export default router;
