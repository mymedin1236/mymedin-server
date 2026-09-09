import "dotenv/config";
import express from "express";
import jwt from "jsonwebtoken";
import cors from "cors";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import { apiLimiter, loginLimiter, forgotLimiter, uploadLimiter } from "./middleware/rateLimit.js";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import clientsRoutes from "./routes/clients.js";
import staffRoutes from "./routes/staff.js";
import familyRoutes from "./routes/family.js";
import appointmentsRoutes from "./routes/appointments.js";
import treatmentsRoutes from "./routes/treatments.js";
import doctorsRoutes from "./routes/doctors.js";
import productsRoutes from "./routes/products.js";
import ordersRoutes from "./routes/orders.js";
import financesRoutes from "./routes/finances.js";
import expensesRoutes from "./routes/expenses.js";
import invoiceRoutes from "./routes/invoices.js";
import associationsRoutes from "./routes/associations.js";
import engagementsRoutes from "./routes/engagements.js";
import notificationsRoutes from "./routes/notifications.js";
import pushRoutes from "./routes/push.js";
import cronRoutes from "./routes/cron.js";
import uploadsRoutes from "./routes/uploads.js";
import adminRoutes from "./routes/admin.js";
import { startAppointmentReminders } from "./jobs/reminders.js";
import { startBalanceReminders } from "./jobs/balanceReminders.js";
import { startInvoiceJob } from "./jobs/invoices.js";
import User from "./models/User.js";
import Notification from "./models/Notification.js";
import Appointment from "./models/Appointment.js";

const app = express();

// Behind Render's proxy — needed so req.ip is the real client (rate limiting).
app.set("trust proxy", 1);

// Security headers. CSP is disabled here (this API serves JSON, not HTML — CSP is
// enforced on the client app), and CORP is set to cross-origin so the SPA on its
// own domain can read responses.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Allowed origins: comma-separated CLIENT_ORIGIN, trailing slashes stripped.
// Empty -> allow all (dev). Tolerates www/non-www and trailing-slash mismatches.
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Also allow this project's own Vercel deployments — the production alias,
// git/preview builds, and named test builds (e.g. dental-app-client-test) —
// so testing URLs work without reconfiguring CLIENT_ORIGIN each time. Scoped to
// the dental-app-client* subdomain only (not all of *.vercel.app). NOTE: this is
// the actual Vercel project slug (infra), unrelated to the app's display brand —
// update it only if/when the Vercel project itself is renamed.
const VERCEL_PROJECT_ORIGIN = /^https:\/\/dental-app-client[a-z0-9-]*\.vercel\.app$/;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser / same-origin requests
      const normalized = origin.replace(/\/+$/, "");
      if (
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(normalized) ||
        VERCEL_PROJECT_ORIGIN.test(normalized)
      ) {
        return cb(null, true);
      }
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

// Raised limit so a cropped avatar data-URL (sent to /api/uploads/avatar) fits.
app.use(express.json({ limit: "8mb" }));

// Strip MongoDB operators ($, .) from inputs to block NoSQL-injection.
app.use(mongoSanitize());

// Health check stays unthrottled (Render pings it).
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Generous catch-all limiter, then tighter limits on sensitive endpoints.
app.use("/api", apiLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/forgot-password", forgotLimiter);
app.use("/api/auth/reset-password", forgotLimiter);
app.use("/api/uploads/avatar", uploadLimiter);

// Read-only enforcement for admin "View as" (impersonation) sessions: a token
// minted with { readOnly: true } may only perform GET requests — every write is
// blocked so an admin can observe a clinic without changing its data.
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) {
    try {
      const p = jwt.verify(h.slice(7), process.env.JWT_SECRET);
      if (p.readOnly) {
        return res.status(403).json({
          message: "You're viewing this clinic in read-only mode. Changes are disabled.",
          code: "READ_ONLY",
        });
      }
    } catch {
      /* invalid/expired token — let protect return 401 */
    }
  }
  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/family", familyRoutes);
app.use("/api/appointments", appointmentsRoutes);
app.use("/api/treatments", treatmentsRoutes);
app.use("/api/doctors", doctorsRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/finances", financesRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/associations", associationsRoutes);
app.use("/api/engagements", engagementsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/admin", adminRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`API listening on :${PORT}`));
    startAppointmentReminders();
    startBalanceReminders();
    startInvoiceJob();
    // Reconcile indexes so the email unique index becomes sparse (lets multiple
    // patients exist without an email). Safe + idempotent on a small collection.
    User.syncIndexes().catch((e) => console.error("User.syncIndexes failed:", e.message));
    // Build the 15-day TTL index so old notifications auto-delete.
    Notification.syncIndexes().catch((e) => console.error("Notification.syncIndexes failed:", e.message));
    // Build the unique "one scheduled appointment per slot" index — makes
    // duplicate bookings impossible at the DB level. If it can't build because
    // pre-existing duplicate scheduled appointments are present, we log a clear
    // message and keep running (the app-level checks still apply); the index
    // activates automatically on the next restart once no duplicates remain.
    Appointment.createIndexes().catch((e) =>
      console.error(
        "[index] Appointment unique-slot index NOT active — remove duplicate scheduled appointments to enable full duplicate protection:",
        e.message
      )
    );
  })
  .catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
