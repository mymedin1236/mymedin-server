import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Review from "../models/Review.js";
import Appointment from "../models/Appointment.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Public profile fields exposed in discovery (never password/email of other users)
const PUBLIC_FIELDS =
  "name clinicName about specialization yearsOfExperience availability slotDuration rating reviewCount location image createdAt address city area services slug";

// GET /api/dentists?lat=..&lng=..&maxKm=..  -> list dentists, nearest first when coords given
router.get("/", async (req, res) => {
  try {
    const { lat, lng, maxKm } = req.query;

    // With coordinates: use $near (requires the 2dsphere index) to sort by distance
    if (lat && lng) {
      const point = {
        type: "Point",
        coordinates: [parseFloat(lng), parseFloat(lat)],
      };
      const near = {
        $near: {
          $geometry: point,
          ...(maxKm ? { $maxDistance: parseFloat(maxKm) * 1000 } : {}),
        },
      };
      const dentists = await User.find({
        role: "dentist",
        location: near,
      }).select(PUBLIC_FIELDS);

      // Attach a distanceKm to each result (Haversine) for display
      const withDistance = dentists.map((d) => {
        const obj = d.toJSON();
        obj.distanceKm = haversineKm(
          parseFloat(lat),
          parseFloat(lng),
          d.location?.coordinates?.[1],
          d.location?.coordinates?.[0]
        );
        return obj;
      });
      return res.json(withDistance);
    }

    // No coordinates: fall back to highest-rated first
    const dentists = await User.find({ role: "dentist" })
      .select(PUBLIC_FIELDS)
      .sort({ rating: -1, reviewCount: -1 });
    res.json(dentists);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/dentists/:id  -> single public profile + recent reviews
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Dentist not found" });
    }
    const dentist = await User.findOne({ _id: req.params.id, role: "dentist" }).select(
      PUBLIC_FIELDS
    );
    if (!dentist) return res.status(404).json({ message: "Dentist not found" });

    // Every appointment the dentist has had since joining — a trust signal on
    // the public profile (all statuses included).
    const bookedCount = await Appointment.countDocuments({ dentist: dentist._id });
    const dentistObj = dentist.toJSON();
    dentistObj.bookedCount = bookedCount;

    const reviews = await Review.find({ dentist: dentist._id })
      .populate("client", "name")
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({ dentist: dentistObj, reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/dentists/:id/booked?from=ISO&to=ISO  -> occupied slot datetimes for a dentist.
// Public (times only, no patient info) so prospective patients can see availability.
router.get("/:id/booked", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.json({ slots: [] });
    const q = { dentist: req.params.id, status: { $in: ["scheduled", "pending"] } };
    const { from, to } = req.query;
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lt = new Date(to);
    }
    const [appts, dentist] = await Promise.all([
      Appointment.find(q).select("date").lean(),
      User.findById(req.params.id).select("slotDuration dayOverrides").lean(),
    ]);
    res.json({
      slots: appts.map((a) => a.date),
      slotDuration: dentist?.slotDuration || 15,
      dayOverrides: dentist?.dayOverrides || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/dentists/:id/reviews  -> client leaves/updates a rating; recompute average
router.post("/:id/reviews", protect, requireRole("client"), async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const numericRating = Number(rating);
    if (!numericRating || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }
    const dentist = await User.findOne({ _id: req.params.id, role: "dentist" });
    if (!dentist) return res.status(404).json({ message: "Dentist not found" });

    // Only patients associated with this dentist (approved) may review them.
    if (String(req.user.dentist || "") !== String(dentist._id)) {
      return res.status(403).json({
        message: "You can review this dentist only after they approve your association.",
      });
    }

    // Upsert: one review per client per dentist
    await Review.findOneAndUpdate(
      { dentist: dentist._id, client: req.user._id },
      { rating: numericRating, comment },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await recomputeRating(dentist._id);

    const reviews = await Review.find({ dentist: dentist._id })
      .populate("client", "name")
      .sort({ createdAt: -1 })
      .limit(20);
    const updated = await User.findById(dentist._id).select(PUBLIC_FIELDS);
    res.status(201).json({ dentist: updated, reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Recalculate a dentist's average rating + count from their reviews
async function recomputeRating(dentistId) {
  const [agg] = await Review.aggregate([
    { $match: { dentist: new mongoose.Types.ObjectId(dentistId) } },
    { $group: { _id: "$dentist", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  await User.findByIdAndUpdate(dentistId, {
    rating: agg ? Math.round(agg.avg * 10) / 10 : 0,
    reviewCount: agg ? agg.count : 0,
  });
}

// Great-circle distance in km, rounded to 1 decimal
function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== "number" || Number.isNaN(v))) {
    return null;
  }
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

export default router;
