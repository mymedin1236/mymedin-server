import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";

export const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: "User no longer exists" });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

// Resolve the clinic owner (doctor) id for any staff member. An assistant acts
// on behalf of the doctor they belong to, so all clinic-scoped data is keyed to
// the doctor's id whether the request comes from the doctor or their assistant.
// For an assistant this reads `user.doctor`, which `resolveClinic` below sets
// in-memory (never persisted) to whichever clinic is active for this request —
// that's what lets an assistant work multiple clinics without a code change here.
export const clinicId = (user) =>
  user.role === "assistant" ? user.doctor : user._id;

// Convenience: middleware allowing any clinic staff (doctor or their assistant).
export const requireStaff = requireRole("doctor", "assistant");

// Validate the X-Active-Clinic header (if present) against an active Engagement.
// Returns the validated doctor id, or null if there's no header or it doesn't
// match a real active engagement. Never throws/blocks on its own.
const validateActiveClinicHeader = async (req) => {
  const doctorId = req.headers["x-active-clinic"];
  if (!doctorId) return null;
  const active = await Engagement.exists({
    assistant: req.user._id,
    doctor: doctorId,
    status: "active",
  });
  return active ? doctorId : null;
};

// An assistant may be actively engaged with several doctors at once (the clinic
// switcher). The client tells us which one is active via the X-Active-Clinic
// header; this validates that engagement and stamps it onto req.user.doctor
// in-memory so every existing clinicId(req.user) call site (and the doctorNameFor
// helpers in associations.js/appointments.js) keeps working unchanged, correctly
// scoped to the request's active clinic. A doctor has exactly one clinic
// (themselves), so this is a no-op for every other role.
//
// This is intentionally strict (blocks without a valid header) for clinic-scoped
// CRUD: if an assistant's active clinic were left unresolved, clinicId(req.user)
// would return undefined, and Mongoose treats a query field of `undefined` as
// absent — silently matching every clinic's documents instead of none. Failing
// closed here is what prevents that data-isolation hole.
export const resolveClinic = async (req, res, next) => {
  try {
    if (req.user.role !== "assistant") return next();
    const doctorId = await validateActiveClinicHeader(req);
    if (!doctorId) {
      return res.status(400).json({ message: "No active clinic selected", code: "NO_ACTIVE_CLINIC" });
    }
    req.user.doctor = doctorId;
    next();
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Soft variant for the notification feed only, which has to stay reachable
// before an assistant has picked (or even has) an active clinic — including to
// see the notification that invites them to their first one. Never blocks;
// sets req.user.doctor when a valid header is present, otherwise leaves it
// unset so callers can filter accordingly instead of hitting a wall.
export const resolveClinicSoft = async (req, res, next) => {
  try {
    if (req.user.role === "assistant") {
      req.user.doctor = (await validateActiveClinicHeader(req)) || undefined;
    }
    next();
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
