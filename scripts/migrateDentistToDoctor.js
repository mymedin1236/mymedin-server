/**
 * One-off data migration for the dentist -> doctor white-label rename.
 *
 * Renaming a Mongoose schema field does NOT touch documents already stored
 * under the old field name, and it does not drop indexes that were built
 * under the old name. This script brings an existing database in line with
 * the renamed schema (models/*.js) before the renamed server code goes live.
 *
 * Run once, against the real database, as part of the same deploy that ships
 * the renamed server + client code — ideally in a short maintenance window,
 * since there is no dual-read compatibility layer for the transition.
 *
 *   node scripts/migrateDentistToDoctor.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";

// Collections that had a `dentist` field (the clinic-owner foreign key).
const DENTIST_FIELD_COLLECTIONS = [
  "users",
  "appointments",
  "treatments",
  "associations",
  "invoices",
  "reviews",
  "expenses",
  "orders",
];

// Old-named indexes to drop so the app can (re)create them under the new
// field name without a duplicate-key surprise from stale index definitions.
// Names not explicitly set in the old schema are Mongo's auto-generated
// "<field>_1_<field>_1" convention.
const OLD_INDEXES = [
  { collection: "appointments", name: "uniq_dentist_slot_scheduled" },
  { collection: "invoices", name: "dentist_1_month_1" },
  { collection: "reviews", name: "dentist_1_client_1" },
  { collection: "associations", name: "dentist_1_status_1" },
];

async function dropIndexIfExists(db, collection, name) {
  try {
    await db.collection(collection).dropIndex(name);
    console.log(`  dropped index ${collection}.${name}`);
  } catch (err) {
    if (err.codeName === "IndexNotFound" || err.code === 27) {
      console.log(`  index ${collection}.${name} not present — skipping`);
    } else {
      throw err;
    }
  }
}

async function run() {
  await connectDB();
  const db = mongoose.connection.db;

  console.log("Renaming `dentist` -> `doctor` field on existing documents…");
  for (const collection of DENTIST_FIELD_COLLECTIONS) {
    const res = await db
      .collection(collection)
      .updateMany({ dentist: { $exists: true } }, { $rename: { dentist: "doctor" } });
    console.log(`  ${collection}: ${res.modifiedCount} document(s) renamed`);
  }

  console.log("Updating role: \"dentist\" -> \"doctor\" on users…");
  const roleRes = await db
    .collection("users")
    .updateMany({ role: "dentist" }, { $set: { role: "doctor" } });
  console.log(`  users: ${roleRes.modifiedCount} document(s) updated`);

  console.log("Renaming `toothNumber` -> `site` on treatments…");
  const siteRes = await db
    .collection("treatments")
    .updateMany({ toothNumber: { $exists: true } }, { $rename: { toothNumber: "site" } });
  console.log(`  treatments: ${siteRes.modifiedCount} document(s) renamed`);

  console.log("Dropping old dentist-named indexes (the app recreates them under the new names on next connect)…");
  for (const { collection, name } of OLD_INDEXES) {
    await dropIndexIfExists(db, collection, name);
  }

  await mongoose.connection.close();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
