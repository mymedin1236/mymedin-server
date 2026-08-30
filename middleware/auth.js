import jwt from "jsonwebtoken";
import User from "../models/User.js";

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

// Resolve the clinic owner (dentist) id for any staff member. An assistant acts
// on behalf of the dentist they belong to, so all clinic-scoped data is keyed to
// the dentist's id whether the request comes from the dentist or their assistant.
export const clinicId = (user) =>
  user.role === "assistant" ? user.dentist : user._id;

// Convenience: middleware allowing any clinic staff (dentist or their assistant).
export const requireStaff = requireRole("dentist", "assistant");
