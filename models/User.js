import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    password: { type: String, required: true, minlength: 8 },
    role: {
      type: String,
      enum: ["doctor", "client", "vendor", "assistant", "admin"],
      required: true,
    },
    // Client-only fields
    dateOfBirth: { type: Date },
    address: { type: String },
    medicalNotes: { type: String },
    // Managed (dependent) patient — e.g. a child with no own phone/email/login.
    // Communication goes to the guardian instead.
    managed: { type: Boolean, default: false },
    guardianName: { type: String, trim: true },
    guardianPhone: { type: String, trim: true }, // not unique (siblings share one)
    guardianEmail: { type: String, trim: true, lowercase: true },
    // When the guardian is a registered patient, link to their account so they
    // can view/manage this dependent and receive its notifications in-app/push.
    guardian: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Link: a client may be created by / belong to a doctor
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // When the patient was last reminded about an outstanding treatment balance,
    // so the reminder job only fires every 15 days per patient.
    lastBalanceReminderAt: { type: Date },

    // How the user most recently accessed the app: true = installed PWA,
    // false = browser tab, undefined = unknown. Updated on login + each app open.
    lastLoginPwa: { type: Boolean },

    // Profile photo (Cloudinary secure URL) — shown on the doctor's public profile.
    image: { type: String, trim: true },

    // Doctor-only profile fields
    clinicName: { type: String, trim: true },
    about: { type: String, trim: true },
    specialization: { type: String, trim: true },
    yearsOfExperience: { type: Number, min: 0 },
    // Directory / SEO fields (optional). Used to build public, search-indexable
    // doctor profile pages and city listings. Safe to leave empty — profiles
    // still render from clinicName, specialization, hours and ratings.
    city: { type: String, trim: true },
    area: { type: String, trim: true },
    services: { type: [String], default: undefined },
    slug: { type: String, trim: true },
    // GeoJSON point for "nearest doctor" discovery: coordinates = [longitude, latitude]
    location: {
      type: { type: String, enum: ["Point"], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    // Weekly availability, e.g. [{ day: "Mon", start: "09:00", end: "17:00" }].
    // A day may hold SEVERAL brackets, and each may name an appointment type —
    // that's what lets one day run different kinds of appointment at different
    // slot lengths (12:00-15:00 consultations, 18:00-21:00 transplants, ...).
    // A bracket with no type uses the clinic's default `slotDuration`, which is
    // how every clinic behaved before types existed.
    availability: [
      {
        _id: false,
        day: { type: String },
        start: { type: String },
        end: { type: String },
        appointmentType: { type: mongoose.Schema.Types.ObjectId, ref: "AppointmentType" },
      },
    ],
    // Default slot length in minutes, used by any bracket that names no type.
    // Controls how clinic hours are divided into bookable time slots.
    slotDuration: { type: Number, default: 15, min: 5, max: 120 },
    // Per-date exceptions to the weekly availability, e.g. the doctor leaving
    // early on a specific day or taking the day off. When an entry matches the
    // booking date it overrides the normal weekly hours for that date only.
    //   { date: "2026-08-02", blocks: [{ start: "09:00", end: "21:00" }] }
    //   { date: "2026-12-25", closed: true }  // day off
    // Like weekly hours, an override may carry several typed brackets. `start`/
    // `end` are the pre-types single-window shape, still read for old records.
    dayOverrides: [
      {
        _id: false,
        date: { type: String }, // YYYY-MM-DD
        closed: { type: Boolean, default: false },
        start: { type: String },
        end: { type: String },
        blocks: [
          {
            _id: false,
            start: { type: String },
            end: { type: String },
            appointmentType: { type: mongoose.Schema.Types.ObjectId, ref: "AppointmentType" },
          },
        ],
      },
    ],
    // Denormalized rating, recomputed from Reviews
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },

    // Vendor-only profile field
    companyName: { type: String, trim: true },

    // Password reset (hashed token + expiry)
    resetTokenHash: { type: String },
    resetTokenExpires: { type: Date },

    // E-signed service agreement (doctor accepts the terms in-app instead of on
    // paper). Records who signed, when, and which version of the terms.
    agreement: {
      acceptedAt: { type: Date },
      name: { type: String, trim: true },
      version: { type: String },
    },

    // Subscription billing, set by the admin (works even for clinics that never
    // signed the e-agreement). Monthly invoices are generated from startMonth on.
    billing: {
      startMonth: { type: String }, // first month to invoice, "YYYY-MM"
      monthlyFee: { type: Number }, // per-clinic override; global default applies if unset
    },
  },
  { timestamps: true }
);

// Geospatial index powers $near queries for nearest-doctor discovery
userSchema.index({ location: "2dsphere" });

// Avoid storing empty-string phone/email, which would violate the sparse unique indexes
userSchema.pre("save", function (next) {
  if (this.phone === "" || this.phone === null) this.phone = undefined;
  if (this.email === "" || this.email === null) this.email = undefined;
  next();
});

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.resetTokenHash;
  delete obj.resetTokenExpires;
  return obj;
};

export default mongoose.model("User", userSchema);
