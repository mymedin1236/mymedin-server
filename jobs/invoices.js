import Invoice from "../models/Invoice.js";
import User from "../models/User.js";

const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";
const CHECK_MS = 6 * 60 * 60 * 1000; // re-check a few times a day

// Standard monthly fee (Rs). Discounted clinics override via billing.monthlyFee
// (e.g. Dr Ahmad is billed Rs 3,000). Overridable globally with MONTHLY_FEE.
export const DEFAULT_MONTHLY_FEE = Number(process.env.MONTHLY_FEE || 3000);

const ISSUE_DAY = 5; // invoices go out on the 5th
const DUE_DAY = 15; // payment due on the 15th

// Today's date parts in the clinic timezone (the server runs in UTC).
function clinicToday(d = new Date()) {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // "YYYY-MM-DD"
  const [y, m, day] = s.split("-").map(Number);
  return { y, m, day, ym: `${y}-${String(m).padStart(2, "0")}` };
}

// A fixed instant (noon clinic time ≈ 07:00 UTC) on the given day of a "YYYY-MM"
// month, so the stored date lands on the intended calendar day everywhere.
function dateForDay(ym, day) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, 7, 0, 0));
}

// Every "YYYY-MM" from startYM through endYM inclusive.
function monthsBetween(startYM, endYM) {
  const [sy, sm] = startYM.split("-").map(Number);
  const [ey, em] = endYM.split("-").map(Number);
  if (!sy || !sm) return [];
  const out = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break; // safety
  }
  return out;
}

// Create any invoices that are due but missing, for every clinic with a billing
// start month. Idempotent (unique dentist+month index), so it can run often and
// safely backfills months the server may have missed.
export async function generateInvoicesOnce() {
  const today = clinicToday();
  const dentists = await User.find({
    role: "dentist",
    "billing.startMonth": { $nin: [null, ""] },
  }).select("_id billing");

  let created = 0;
  for (const d of dentists) {
    const start = d.billing?.startMonth;
    if (!start) continue;
    const fee = Number(d.billing?.monthlyFee) || DEFAULT_MONTHLY_FEE;

    for (const month of monthsBetween(start, today.ym)) {
      // Don't issue the current month before the 5th; past months always issue.
      if (month === today.ym && today.day < ISSUE_DAY) continue;
      if (await Invoice.exists({ dentist: d._id, month })) continue;
      try {
        await Invoice.create({
          dentist: d._id,
          month,
          amount: fee,
          issueDate: dateForDay(month, ISSUE_DAY),
          dueDate: dateForDay(month, DUE_DAY),
          status: "unpaid",
        });
        created += 1;
      } catch (e) {
        if (e?.code !== 11000) console.error("[invoice] create:", e?.message);
      }
    }
  }
  if (created) console.log(`[invoice] generated ${created} invoice(s)`);
  return created;
}

// In-process timer plus a run at startup (a managed cron hitting
// /api/cron/generate-invoices covers free-tier instances that sleep).
export function startInvoiceJob() {
  generateInvoicesOnce().catch((e) => console.error("[invoice] error:", e?.message));
  setInterval(
    () => generateInvoicesOnce().catch((e) => console.error("[invoice] error:", e?.message)),
    CHECK_MS
  );
}
