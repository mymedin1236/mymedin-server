import express from "express";
import PushSubscription from "../models/PushSubscription.js";
import { pushConfigured } from "../utils/push.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

// Public VAPID key for the client to subscribe with (no auth needed)
router.get("/public-key", (req, res) => {
  res.json({ publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : null });
});

router.use(protect);

// POST /api/push/subscribe -> save (or refresh) this user's push subscription
router.post("/subscribe", async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ message: "Invalid subscription" });
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { user: req.user._id, endpoint, keys },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ message: "subscribed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/push/unsubscribe
router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await PushSubscription.deleteOne({ endpoint, user: req.user._id });
  res.json({ message: "unsubscribed" });
});

export default router;
