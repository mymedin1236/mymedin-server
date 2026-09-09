/**
 * One-off data migration for the assistant -> portable-identity rework.
 *
 * Before this change, an assistant's clinic membership was a single `doctor`
 * field on their own User document. Clinic-scoped code now resolves the active
 * clinic through an Engagement row instead (see middleware/auth.js resolveClinic),
 * so every existing assistant needs one active Engagement created from their
 * current `doctor` link before the new server code goes live — otherwise they'd
 * have no clinic to select in the switcher and would lose access on next login.
 *
 * `User.doctor` is left in place afterward (unused by the new code path, but
 * harmless) — nothing here removes it.
 *
 * Defaults to a dry run (report only, no writes). Pass --write to apply:
 *
 *   node scripts/migrateAssistantsToEngagements.js          # dry run
 *   node scripts/migrateAssistantsToEngagements.js --write  # apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";

const WRITE = process.argv.includes("--write");

async function run() {
  await connectDB();

  const assistants = await User.find({ role: "assistant", doctor: { $exists: true, $ne: null } }).select(
    "_id doctor createdAt"
  );
  console.log(`Found ${assistants.length} assistant(s) with a doctor link.`);

  let created = 0;
  let skipped = 0;
  for (const a of assistants) {
    const existing = await Engagement.findOne({
      assistant: a._id,
      doctor: a.doctor,
      status: { $in: ["pending", "active"] },
    });
    if (existing) {
      skipped++;
      continue;
    }
    console.log(
      `  ${WRITE ? "creating" : "would create"} Engagement { assistant: ${a._id}, doctor: ${a.doctor}, status: "active" }`
    );
    if (WRITE) {
      await Engagement.create({
        assistant: a._id,
        doctor: a.doctor,
        status: "active",
        initiatedBy: "doctor",
        startedAt: a.createdAt,
      });
    }
    created++;
  }

  console.log(
    `\n${WRITE ? "Created" : "Would create"} ${created} Engagement(s); ${skipped} already had one and were skipped.`
  );
  if (!WRITE) console.log("Dry run only — re-run with --write to apply.");

  await mongoose.connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
