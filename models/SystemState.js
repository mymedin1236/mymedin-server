import mongoose from "mongoose";

// Tiny key/value store for server-side job state that must survive restarts
// (free-tier instances sleep, so in-memory flags are lost on every wake).
const systemStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

export default mongoose.model("SystemState", systemStateSchema);
