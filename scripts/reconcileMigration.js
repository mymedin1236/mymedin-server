// Reconcile writes that landed in the OLD database after a migration snapshot
// was taken (e.g. patients kept booking while the copy was running).
//
// It is SAFE by default:
//   • Dry run unless you pass --apply (prints exactly what it WOULD do).
//   • Only ever copies SOURCE -> TARGET. Nothing is deleted, ever.
//   • Documents are matched by _id, which survives a Mongo migration, so the
//     whole run is idempotent — re-running it changes nothing new.
//   • A scheduled appointment whose doctor+time slot is already taken in TARGET
//     by a DIFFERENT patient is a real double-booking: it is only REPORTED,
//     never inserted (it would also hit uniq_doctor_slot_scheduled and throw).
//   • Docs that exist in TARGET but are NEWER in SOURCE are reported as STALE
//     and left alone unless you additionally pass --overwrite-stale.
//
// Usage (run from the mymedin-server folder, with your normal .env in place):
//   node scripts/reconcileMigration.js --source=<old-uri> --since=2026-09-16T00:00:00Z
//   node scripts/reconcileMigration.js --source=<old-uri> --since=... --apply
//
// --target defaults to MONGO_URI from .env (i.e. the new database).
// --since is the moment your snapshot was taken; anything written to the old
// database after it is a candidate. Err on the EARLY side — extra candidates
// are matched by _id and skipped as already-present, so an early cutoff is free.
import "dotenv/config";
import { MongoClient } from "mongodb";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const APPLY = process.argv.includes("--apply");
const OVERWRITE_STALE = process.argv.includes("--overwrite-stale");

const SOURCE = arg("source");
const TARGET = arg("target") || process.env.MONGO_URI;
const SINCE = arg("since") ? new Date(arg("since")) : undefined;

if (!SOURCE || !TARGET || !SINCE || Number.isNaN(+SINCE)) {
  console.error(
    "Usage: node scripts/reconcileMigration.js --source=<uri> [--target=<uri>] --since=<ISO date> [--apply] [--overwrite-stale]"
  );
  process.exit(1);
}

// Same rule the app uses (config/db.js): MONGO_DB wins, else the name in the URI.
const dbNameFromUri = (uri) => {
  const afterHost = uri.replace(/^mongodb(\+srv)?:\/\/[^/]+\//i, "");
  return afterHost.split("?")[0].split("/")[0] || "";
};
const dbOf = (client, uri, override) =>
  client.db(override || dbNameFromUri(uri) || "mymedin");

// Every collection that takes writes during normal clinic hours.
const COLLECTIONS = [
  "appointments",
  "treatments",
  "users",
  "notifications",
  "orders",
  "expenses",
  "engagements",
  "reviews",
  "invoices",
  "associations",
  "pushsubscriptions",
];

const srcClient = new MongoClient(SOURCE);
const dstClient = new MongoClient(TARGET);
await srcClient.connect();
await dstClient.connect();
const src = dbOf(srcClient, SOURCE, arg("source-db"));
const dst = dbOf(dstClient, TARGET, arg("target-db") || process.env.MONGO_DB);

console.log(`SOURCE  ${src.databaseName}`);
console.log(`TARGET  ${dst.databaseName}`);
console.log(`SINCE   ${SINCE.toISOString()}`);
console.log(APPLY ? "MODE    APPLY (will write)\n" : "MODE    dry run (no changes)\n");

const totals = { missing: 0, stale: 0, conflict: 0, present: 0, inserted: 0, updated: 0 };

for (const name of COLLECTIONS) {
  const candidates = await src
    .collection(name)
    .find({ $or: [{ createdAt: { $gt: SINCE } }, { updatedAt: { $gt: SINCE } }] })
    .toArray();
  if (!candidates.length) continue;

  const missing = [];
  const stale = [];
  const conflicts = [];

  for (const doc of candidates) {
    const existing = await dst.collection(name).findOne({ _id: doc._id });
    if (!existing) {
      // A scheduled appointment can only be inserted if its slot is free in
      // TARGET — the partial unique index would reject it otherwise, and a
      // different patient in that slot is a booking clash for a human to settle.
      if (name === "appointments" && doc.status === "scheduled") {
        const taken = await dst.collection(name).findOne({
          doctor: doc.doctor,
          date: doc.date,
          status: "scheduled",
        });
        if (taken && String(taken.client) !== String(doc.client)) {
          conflicts.push({ doc, taken });
          continue;
        }
      }
      missing.push(doc);
    } else if (doc.updatedAt && existing.updatedAt && doc.updatedAt > existing.updatedAt) {
      stale.push(doc);
    } else {
      totals.present++;
    }
  }

  if (!missing.length && !stale.length && !conflicts.length) continue;

  console.log(`\n── ${name}`);
  for (const doc of missing) {
    console.log(`   MISSING   _id=${doc._id}  ${describe(name, doc)}`);
  }
  for (const doc of stale) {
    console.log(`   STALE     _id=${doc._id}  source is newer  ${describe(name, doc)}`);
  }
  for (const { doc, taken } of conflicts) {
    console.log(
      `   CONFLICT  _id=${doc._id}  slot already booked in target by client ${taken.client} (target _id=${taken._id})  ${describe(name, doc)}`
    );
  }

  totals.missing += missing.length;
  totals.stale += stale.length;
  totals.conflict += conflicts.length;

  if (APPLY) {
    if (missing.length) {
      await dst.collection(name).insertMany(missing, { ordered: false });
      totals.inserted += missing.length;
    }
    if (OVERWRITE_STALE) {
      for (const doc of stale) {
        const { _id, ...rest } = doc;
        await dst.collection(name).replaceOne({ _id }, { _id, ...rest });
        totals.updated++;
      }
    }
  }
}

// A one-line human summary per document, so the report is readable without
// cross-referencing ids against the database.
function describe(name, doc) {
  switch (name) {
    case "appointments":
      return `${new Date(doc.date).toISOString()} ${doc.status} ${doc.typeName || ""}`.trim();
    case "treatments":
      return `${doc.procedure} cost=${doc.cost} payments=${(doc.payments || []).length}`;
    case "users":
      return `${doc.name || ""} <${doc.email || ""}> ${doc.role || ""}`.trim();
    default:
      return new Date(doc.createdAt || doc.updatedAt || 0).toISOString();
  }
}

console.log(`\n────────────────────────────────`);
console.log(`already in target : ${totals.present}`);
console.log(`missing           : ${totals.missing}${APPLY ? ` (inserted ${totals.inserted})` : ""}`);
console.log(`stale in target   : ${totals.stale}${APPLY && OVERWRITE_STALE ? ` (updated ${totals.updated})` : ""}`);
console.log(`slot conflicts    : ${totals.conflict}  <- resolve these by hand`);
if (!APPLY && (totals.missing || totals.stale)) {
  console.log(`\nRe-run with --apply to copy the missing documents across.`);
}

await srcClient.close();
await dstClient.close();
