// ---------------------------------------------------------------------------
// Slot engine — the single source of truth for turning a doctor's operational
// hours into concrete bookable slots.
//
// A clinic day is made of one or more "brackets" (operational-hours blocks).
// Each bracket may carry an appointment TYPE, and each type has its own slot
// length. So a hair specialist can run:
//
//   12:00–15:00  Consultation     (20 min slots)
//   16:00–18:00  PRP session      (40 min slots)
//   18:00–21:00  Hair transplant  (90 min slots)
//
// Nothing here is specific to that example: a bracket with no type simply falls
// back to the clinic's default slot length, which is exactly how the app behaved
// before types existed.
//
// This module is PURE (no DB, no I/O) and is mirrored verbatim in the client at
// src/utils/slots.js so the grid a patient taps and the grid the server
// validates against can never drift apart.
// ---------------------------------------------------------------------------

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Slot length used when a bracket has no type and the clinic set no default.
export const DEFAULT_SLOT_MINUTES = 15;

export const hhmmToMin = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  if (!Number.isFinite(h)) return NaN;
  return h * 60 + (Number.isFinite(m) ? m : 0);
};

export const minToHhmm = (m) => {
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// Index a list of appointment types by their id, for O(1) lookup while building.
export const indexTypes = (types = []) => {
  const map = new Map();
  for (const t of types) {
    if (t && t._id) map.set(String(t._id), t);
  }
  return map;
};

const isHHMM = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ""));

// Normalise one raw bracket ({ start, end, appointmentType }) into
// { start: minutes, end: minutes, typeId }. Returns null if malformed.
const toBracket = (raw) => {
  if (!raw || !isHHMM(raw.start) || !isHHMM(raw.end)) return null;
  const start = hhmmToMin(raw.start);
  const end = hhmmToMin(raw.end);
  if (!(end > start)) return null;
  return {
    start,
    end,
    typeId: raw.appointmentType ? String(raw.appointmentType) : null,
  };
};

// Every bracket a per-date override defines. Supports both the current shape
// (`blocks: [{ start, end, appointmentType }]`) and the original single-window
// shape (`start`/`end` on the override itself), so overrides saved before this
// feature keep working untouched.
const overrideBrackets = (ov) => {
  const list = Array.isArray(ov.blocks) && ov.blocks.length ? ov.blocks : [ov];
  return list.map(toBracket).filter(Boolean);
};

// The operational-hours brackets in effect for one calendar day.
//
//   null  -> hours are unknown (caller hasn't loaded them yet)
//   []    -> the clinic is closed that day
//
// A per-date override replaces the weekly hours for that date entirely; a
// malformed override falls through to the weekly hours rather than closing the
// day by accident.
export function bracketsForDay({ availability = [], dayOverrides = [], dayStr, dow }) {
  const ov = (dayOverrides || []).find((o) => o && o.date === dayStr);
  if (ov) {
    if (ov.closed) return [];
    const brackets = overrideBrackets(ov);
    if (brackets.length) return sortBrackets(brackets);
  }

  const label = DAY_LABELS[dow];
  const brackets = (availability || [])
    .filter((a) => a && a.day === label)
    .map(toBracket)
    .filter(Boolean);
  if (brackets.length) return sortBrackets(brackets);

  // A clinic that has configured no hours at all still needs to be bookable.
  if (!availability || availability.length === 0) return [{ start: 9 * 60, end: 18 * 60, typeId: null }];
  return []; // hours configured, but this weekday is closed
}

const sortBrackets = (b) => [...b].sort((x, y) => x.start - y.start || x.end - y.end);

// How long one appointment of `typeId` takes, in minutes.
const durationFor = (typeId, typesById, defaultDuration) => {
  const t = typeId ? typesById.get(typeId) : null;
  const d = Number(t?.duration);
  return Number.isFinite(d) && d > 0 ? d : defaultDuration;
};

// Turn brackets into the concrete slots patients can book.
//
// Slots are laid out from each bracket's start at the type's own cadence, and a
// slot is only emitted if it fits ENTIRELY inside its bracket — a 90-minute
// transplant slot is never opened at 20:00 in an 18:00–21:00 bracket, because it
// would run past closing. Any leftover tail (e.g. 20:00–21:00 after two 90-min
// slots) is simply not bookable, which is the correct clinical behaviour.
//
// Returns [{ start, end, duration, typeId, typeName, color }] sorted by start,
// with `start`/`end` as minutes since midnight in clinic time.
export function buildDaySlots(brackets, { types = [], defaultDuration = DEFAULT_SLOT_MINUTES } = {}) {
  if (!brackets) return null;
  const typesById = indexTypes(types);
  const fallback = Number(defaultDuration) > 0 ? Number(defaultDuration) : DEFAULT_SLOT_MINUTES;

  const out = [];
  const seen = new Set();
  for (const b of brackets) {
    const duration = durationFor(b.typeId, typesById, fallback);
    const type = b.typeId ? typesById.get(b.typeId) : null;
    // An archived/deleted type leaves its bracket bookable at the clinic default
    // rather than silently dropping those hours off the calendar.
    for (let t = b.start; t + duration <= b.end; t += duration) {
      const key = `${t}:${b.typeId || ""}`;
      if (seen.has(key)) continue; // duplicate bracket for the same type
      seen.add(key);
      out.push({
        start: t,
        end: t + duration,
        duration,
        typeId: b.typeId,
        typeName: type?.name || "",
        color: type?.color || "",
        time: minToHhmm(t),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.duration - b.duration);
}

// Convenience: brackets + slots for a day in one call.
export function slotsForDay({ availability, dayOverrides, dayStr, dow, types, defaultDuration }) {
  const brackets = bracketsForDay({ availability, dayOverrides, dayStr, dow });
  return buildDaySlots(brackets, { types, defaultDuration });
}

// Half-open interval overlap: [aStart, aEnd) vs [bStart, bEnd).
export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// The slot starting exactly at `minutes`. When several types share a start time
// (overlapping brackets), `typeId` picks the intended one; without it the first
// match wins so an untyped request still resolves to a real slot.
export function findSlotAt(slots, minutes, typeId) {
  if (!slots) return null;
  const at = slots.filter((s) => s.start === minutes);
  if (!at.length) return null;
  if (typeId) return at.find((s) => String(s.typeId) === String(typeId)) || null;
  return at[0];
}
