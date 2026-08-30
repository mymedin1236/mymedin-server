// Create (or update) the platform admin account.
// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strongpass' npm run seed:admin
import "dotenv/config";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
const name = process.env.ADMIN_NAME || "Administrator";

if (!email || !password) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD env vars first.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

await connectDB();

let user = await User.findOne({ email });
if (user) {
  user.role = "admin";
  user.password = password; // re-hashed by the pre-save hook
  user.name = user.name || name;
  await user.save();
  console.log(`Updated existing user ${email} -> admin, password reset.`);
} else {
  await User.create({ name, email, password, role: "admin" });
  console.log(`Created admin ${email}.`);
}
process.exit(0);
