import mongoose from "mongoose";

// Extract the database name from a Mongo connection string
// (mongodb+srv://user:pass@host/<dbname>?params) — returns "" if absent.
const dbNameFromUri = (uri) => {
  const afterHost = uri.replace(/^mongodb(\+srv)?:\/\/[^/]+\//i, "");
  return afterHost.split("?")[0].split("/")[0] || "";
};

export const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  // Single database for all environments: MONGO_DB if set, otherwise the name
  // embedded in MONGO_URI. (No separate "-dev" database — local and production
  // both use whatever MONGO_URI points to.)
  const dbName = process.env.MONGO_DB || dbNameFromUri(uri) || "mymedin";

  await mongoose.connect(uri, dbName ? { dbName } : {});
  console.log(
    `MongoDB connected — db "${dbName}" (${process.env.NODE_ENV || "development"})`
  );
};
