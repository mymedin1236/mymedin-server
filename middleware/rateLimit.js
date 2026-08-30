import rateLimit from "express-rate-limit";

const base = { standardHeaders: true, legacyHeaders: false };

// Tight limit on login to blunt brute-force / credential stuffing.
export const loginLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { message: "Too many attempts. Please wait a few minutes and try again." },
});

// Password-reset requests — avoid email spam and enumeration probing.
export const forgotLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 6,
  message: { message: "Too many requests. Please wait a few minutes and try again." },
});

// Public avatar upload (unauthenticated for registration) — keep abuse low.
export const uploadLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 30,
  message: { message: "Too many uploads. Please try again later." },
});

// Generous catch-all so a bot can't hammer the API, without affecting normal use.
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  message: { message: "Too many requests. Please slow down." },
});
