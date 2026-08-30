import webpush from "web-push";
import PushSubscription from "../models/PushSubscription.js";

export const pushConfigured = !!(
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
);

if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@mydentalbooking.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Send a push notification to every subscription a user has registered.
// Dead subscriptions (404/410) are pruned automatically. Never throws.
export async function sendPush(userId, payload) {
  if (!pushConfigured) return;
  try {
    const subs = await PushSubscription.find({ user: userId });
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map((sub) =>
        webpush
          .sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            body
          )
          .catch(async (err) => {
            if (err.statusCode === 404 || err.statusCode === 410) {
              await PushSubscription.deleteOne({ _id: sub._id });
            } else {
              console.error("[push] send failed:", err.statusCode || err.message);
            }
          })
      )
    );
  } catch (err) {
    console.error("[push] error:", err.message);
  }
}
