import express from "express";
import Treatment from "../models/Treatment.js";
import Order from "../models/Order.js";
import Expense from "../models/Expense.js";
import { protect, requireRole, clinicId } from "../middleware/auth.js";

const router = express.Router();

// Finances (income totals, trends) are the clinic owner's — assistants must not
// see them. Doctor-only across every endpoint in this router.
router.use(protect, requireRole("doctor"));

// GET /api/finances/summary -> income (treatments), expenses (supply orders), trends, outstanding
router.get("/summary", async (req, res) => {
  try {
    const doctorId = clinicId(req.user);

    // --- Income from treatments (collected = sum of actual payments) ---
    const [income] = await Treatment.aggregate([
      { $match: { doctor: doctorId } },
      { $addFields: { collected: { $sum: "$payments.amount" } } },
      {
        $group: {
          _id: null,
          totalBilled: { $sum: "$cost" },
          totalCollected: { $sum: "$collected" },
          treatmentCount: { $sum: 1 },
          paidCount: {
            $sum: { $cond: [{ $gte: ["$collected", "$cost"] }, 1, 0] },
          },
        },
      },
    ]);

    // --- Expenses from supply orders (cancelled excluded) ---
    const [expense] = await Order.aggregate([
      { $match: { doctor: doctorId, status: { $ne: "cancelled" } } },
      { $group: { _id: null, totalSpent: { $sum: "$total" }, orderCount: { $sum: 1 } } },
    ]);

    // --- Maintenance expenses ---
    const [maintenance] = await Expense.aggregate([
      { $match: { doctor: doctorId } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);

    const totalBilled = income?.totalBilled || 0;
    const totalCollected = income?.totalCollected || 0;
    const totalSpent = expense?.totalSpent || 0;
    const totalMaintenance = maintenance?.total || 0;
    const totalExpenses = totalSpent + totalMaintenance;

    // --- Monthly trend (last 6 months): collected income vs supply spend ---
    const incomeByMonth = await Treatment.aggregate([
      { $match: { doctor: doctorId } },
      { $unwind: "$payments" },
      {
        $group: {
          _id: { y: { $year: "$payments.date" }, m: { $month: "$payments.date" } },
          amount: { $sum: "$payments.amount" },
        },
      },
    ]);
    const orderByMonth = await Order.aggregate([
      { $match: { doctor: doctorId, status: { $ne: "cancelled" } } },
      {
        $group: {
          _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } },
          amount: { $sum: "$total" },
        },
      },
    ]);
    const maintByMonth = await Expense.aggregate([
      { $match: { doctor: doctorId } },
      {
        $group: {
          _id: { y: { $year: "$date" }, m: { $month: "$date" } },
          amount: { $sum: "$amount" },
        },
      },
    ]);
    // Combined expense series = supply orders + maintenance, summed per month
    const expenseByMonth = mergeMonthly(orderByMonth, maintByMonth);

    const monthly = buildMonthlySeries(incomeByMonth, expenseByMonth, 6);

    // --- Outstanding (unpaid) treatments ---
    const unpaid = await Treatment.find({
      doctor: doctorId,
      $expr: { $lt: [{ $sum: "$payments.amount" }, "$cost"] },
    })
      .populate("client", "name")
      .sort({ date: -1 })
      .limit(50);

    res.json({
      totals: {
        totalBilled,
        totalCollected,
        outstanding: totalBilled - totalCollected,
        totalSpent,
        totalMaintenance,
        totalExpenses,
        net: totalCollected - totalExpenses,
        treatmentCount: income?.treatmentCount || 0,
        paidCount: income?.paidCount || 0,
        unpaidCount: (income?.treatmentCount || 0) - (income?.paidCount || 0),
        orderCount: expense?.orderCount || 0,
        maintenanceCount: maintenance?.count || 0,
      },
      monthly,
      unpaid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// --- Trend analytics: income vs expenses bucketed by day / week / month / year ---
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PERIODS = {
  day: { unit: "day", count: 14 },
  week: { unit: "week", count: 8 },
  month: { unit: "month", count: 6 },
  year: { unit: "year", count: 5 },
};
const pad2 = (n) => String(n).padStart(2, "0");
const tzParts = (d) => {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce((o, x) => ((o[x.type] = x.value), o), {});
  return { y: +p.year, m: +p.month, d: +p.day };
};

// The contiguous list of period-start keys (YYYY-MM-DD, clinic-tz) ending now,
// each with a display label — so the chart shows continuous buckets incl. zeros.
function buildKeys(period) {
  const { count } = PERIODS[period];
  const now = tzParts(new Date());
  const out = [];

  if (period === "year") {
    for (let i = count - 1; i >= 0; i--) {
      const y = now.y - i;
      out.push({ key: `${y}-01-01`, label: `${y}` });
    }
  } else if (period === "month") {
    let y = now.y;
    let m = now.m;
    const tmp = [];
    for (let i = 0; i < count; i++) {
      tmp.push({ key: `${y}-${pad2(m)}-01`, label: `${MONTHS[m - 1]} ${y}` });
      if (--m === 0) { m = 12; y--; }
    }
    out.push(...tmp.reverse());
  } else if (period === "day") {
    const anchor = Date.UTC(now.y, now.m - 1, now.d);
    for (let i = count - 1; i >= 0; i--) {
      const t = new Date(anchor - i * 86400000);
      out.push({
        key: `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`,
        label: `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`,
      });
    }
  } else {
    // week — buckets start on Sunday (matches $dateTrunc default)
    const anchor = Date.UTC(now.y, now.m - 1, now.d);
    const weekStart = anchor - new Date(anchor).getUTCDay() * 86400000;
    for (let i = count - 1; i >= 0; i--) {
      const t = new Date(weekStart - i * 7 * 86400000);
      out.push({
        key: `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`,
        label: `wk ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`,
      });
    }
  }
  return out;
}

// UTC instant whose clinic-tz wall clock is (y, m, d, h, mi) — handles the tz offset.
function wallToUtc(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(guess))
    .reduce((o, x) => ((o[x.type] = x.value), o), {});
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (wall - guess));
}

// [start, end) instants + label for the given period, `offset` periods back from now.
function computeWindow(period, offset) {
  const now = tzParts(new Date());
  if (period === "year") {
    const y = now.y - offset;
    return { start: wallToUtc(y, 1, 1), end: wallToUtc(y + 1, 1, 1), label: `${y}` };
  }
  if (period === "month") {
    const mi = now.y * 12 + (now.m - 1) - offset;
    const y = Math.floor(mi / 12);
    const m = (mi % 12) + 1;
    return { start: wallToUtc(y, m, 1), end: wallToUtc(y, m + 1, 1), label: `${MONTHS[m - 1]} ${y}` };
  }
  if (period === "day") {
    const t = new Date(Date.UTC(now.y, now.m - 1, now.d) - offset * 86400000);
    const y = t.getUTCFullYear();
    const m = t.getUTCMonth() + 1;
    const d = t.getUTCDate();
    return { start: wallToUtc(y, m, d), end: wallToUtc(y, m, d + 1), label: `${d} ${MONTHS[m - 1]} ${y}` };
  }
  // week (Sunday start)
  const anchor = Date.UTC(now.y, now.m - 1, now.d);
  const dow = new Date(anchor).getUTCDay();
  const wsMs = anchor - dow * 86400000 - offset * 7 * 86400000;
  const ws = new Date(wsMs);
  const we = new Date(wsMs + 6 * 86400000);
  return {
    start: wallToUtc(ws.getUTCFullYear(), ws.getUTCMonth() + 1, ws.getUTCDate()),
    end: wallToUtc(we.getUTCFullYear(), we.getUTCMonth() + 1, we.getUTCDate() + 1),
    label: `${ws.getUTCDate()} ${MONTHS[ws.getUTCMonth()]} – ${we.getUTCDate()} ${MONTHS[we.getUTCMonth()]}`,
  };
}

// GET /api/finances/period?period=day|week|month|year&offset=N
// Collected / Expenses / Outstanding for a single period, each with line-item details.
router.get("/period", async (req, res) => {
  try {
    const doctorId = clinicId(req.user);
    const period = PERIODS[req.query.period] ? req.query.period : "month";
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { start, end, label } = computeWindow(period, offset);
    const inRange = { $gte: start, $lt: end };

    const [collectedItems, orderItems, maintItems, outstandingItems] = await Promise.all([
      // Payments collected within the period
      Treatment.aggregate([
        { $match: { doctor: doctorId } },
        { $unwind: "$payments" },
        { $match: { "payments.date": inRange } },
        { $lookup: { from: "users", localField: "client", foreignField: "_id", as: "c" } },
        {
          $project: {
            _id: 0,
            treatmentId: "$_id",
            clientId: "$client",
            date: "$payments.date",
            amount: "$payments.amount",
            note: "$payments.note",
            method: "$payments.method",
            procedure: 1,
            client: { $arrayElemAt: ["$c.name", 0] },
          },
        },
        { $sort: { date: -1 } },
      ]),
      // Supply orders within the period
      Order.aggregate([
        { $match: { doctor: doctorId, status: { $ne: "cancelled" }, createdAt: inRange } },
        { $project: { _id: 0, date: "$createdAt", title: "Supply order", amount: "$total", kind: "supply" } },
      ]),
      // Maintenance expenses within the period
      Expense.aggregate([
        { $match: { doctor: doctorId, date: inRange } },
        { $project: { _id: 0, date: 1, title: 1, amount: 1, category: 1, kind: "maintenance" } },
      ]),
      // Treatments billed within the period that still have a balance
      Treatment.aggregate([
        { $match: { doctor: doctorId, date: inRange } },
        { $addFields: { paidAmount: { $sum: "$payments.amount" } } },
        { $addFields: { balance: { $subtract: ["$cost", "$paidAmount"] } } },
        { $match: { balance: { $gt: 0 } } },
        { $lookup: { from: "users", localField: "client", foreignField: "_id", as: "c" } },
        {
          $project: {
            _id: 1,
            clientId: "$client",
            date: 1,
            procedure: 1,
            cost: 1,
            balance: 1,
            client: { $arrayElemAt: ["$c.name", 0] },
          },
        },
        { $sort: { date: -1 } },
      ]),
    ]);

    const sum = (arr, k) => arr.reduce((s, i) => s + (i[k] || 0), 0);
    const expenseItems = [...orderItems, ...maintItems].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Split collected payments by method. Anything not explicitly "online" counts
    // as cash (the default), so cash + online always equals the grand total.
    const onlineItems = collectedItems.filter((i) => i.method === "online");
    const cashItems = collectedItems.filter((i) => i.method !== "online");

    res.json({
      period,
      offset,
      label,
      collected: {
        total: sum(collectedItems, "amount"),
        items: collectedItems,
        cash: { total: sum(cashItems, "amount"), items: cashItems },
        online: { total: sum(onlineItems, "amount"), items: onlineItems },
      },
      expenses: { total: sum(expenseItems, "amount"), items: expenseItems },
      outstanding: { total: sum(outstandingItems, "balance"), items: outstandingItems },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/finances/trend?period=day|week|month|year
router.get("/trend", async (req, res) => {
  try {
    const doctorId = clinicId(req.user);
    const period = PERIODS[req.query.period] ? req.query.period : "month";
    const { unit } = PERIODS[period];

    // Bucket key = the period's start date (clinic-tz) as YYYY-MM-DD.
    const keyOf = (dateField) => ({
      $dateToString: {
        format: "%Y-%m-%d",
        timezone: CLINIC_TZ,
        date: {
          $dateTrunc: {
            date: dateField,
            unit,
            timezone: CLINIC_TZ,
            ...(unit === "week" ? { startOfWeek: "sunday" } : {}),
          },
        },
      },
    });

    const [income, orders, maint] = await Promise.all([
      Treatment.aggregate([
        { $match: { doctor: doctorId } },
        { $unwind: "$payments" },
        { $group: { _id: keyOf("$payments.date"), amount: { $sum: "$payments.amount" } } },
      ]),
      Order.aggregate([
        { $match: { doctor: doctorId, status: { $ne: "cancelled" } } },
        { $group: { _id: keyOf("$createdAt"), amount: { $sum: "$total" } } },
      ]),
      Expense.aggregate([
        { $match: { doctor: doctorId } },
        { $group: { _id: keyOf("$date"), amount: { $sum: "$amount" } } },
      ]),
    ]);

    const incomeMap = new Map(income.map((r) => [r._id, r.amount]));
    const expenseMap = new Map();
    for (const r of [...orders, ...maint]) {
      expenseMap.set(r._id, (expenseMap.get(r._id) || 0) + r.amount);
    }

    const series = buildKeys(period).map(({ key, label }) => ({
      label,
      income: incomeMap.get(key) || 0,
      expense: expenseMap.get(key) || 0,
    }));

    res.json({ period, series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Sum two month-bucketed aggregates ([{_id:{y,m}, amount}]) into one
function mergeMonthly(a, b) {
  const map = new Map();
  for (const r of [...a, ...b]) {
    const k = `${r._id.y}-${r._id.m}`;
    const existing = map.get(k);
    if (existing) existing.amount += r.amount;
    else map.set(k, { _id: { y: r._id.y, m: r._id.m }, amount: r.amount });
  }
  return [...map.values()];
}

// Merge income/expense aggregates into the last `count` calendar months (oldest first)
function buildMonthlySeries(incomeAgg, expenseAgg, count) {
  const key = (y, m) => `${y}-${m}`;
  const incomeMap = new Map(incomeAgg.map((r) => [key(r._id.y, r._id.m), r.amount]));
  const expenseMap = new Map(expenseAgg.map((r) => [key(r._id.y, r._id.m), r.amount]));
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Anchor on the most recent month present in the data (avoids needing Date.now())
  const allKeys = [...incomeAgg, ...expenseAgg].map((r) => r._id.y * 12 + (r._id.m - 1));
  if (allKeys.length === 0) return [];
  const endIdx = Math.max(...allKeys); // months since year 0

  const series = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = endIdx - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const k = key(y, m);
    series.push({
      label: `${labels[m - 1]} ${y}`,
      income: incomeMap.get(k) || 0,
      expense: expenseMap.get(k) || 0,
    });
  }
  return series;
}

export default router;
