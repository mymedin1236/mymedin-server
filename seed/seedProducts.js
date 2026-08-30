/**
 * Seeds a demo vendor and a catalog of common medical practice supplies.
 * Run from the server/ directory:  node seed/seedProducts.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Product from "../models/Product.js";

// Common items a medical practice uses day to day, grouped by category.
// price is illustrative (USD); unit reflects how the item is usually sold.
const CATALOG = [
  // Instruments
  { name: "Stethoscope (Dual-Head)", category: "Instruments", price: 25, unit: "each", stock: 60 },
  { name: "Blood Pressure Monitor (Manual)", category: "Instruments", price: 22, unit: "each", stock: 50 },
  { name: "Digital Thermometer", category: "Instruments", price: 6, unit: "each", stock: 150 },
  { name: "Pulse Oximeter", category: "Instruments", price: 18, unit: "each", stock: 90 },
  { name: "Otoscope / Ophthalmoscope Set", category: "Instruments", price: 85, unit: "set", stock: 25 },
  { name: "Reflex Hammer", category: "Instruments", price: 5, unit: "each", stock: 80 },
  { name: "Surgical Scissors (Straight)", category: "Instruments", price: 9, unit: "each", stock: 70 },
  { name: "Forceps (Standard)", category: "Instruments", price: 7, unit: "each", stock: 70 },
  { name: "Examination Light (Penlight)", category: "Instruments", price: 4, unit: "each", stock: 120 },

  // Consumables
  { name: "Alcohol Swabs", category: "Consumables", price: 6, unit: "box of 200", stock: 200 },
  { name: "Gauze Pads (4x4)", category: "Consumables", price: 8, unit: "box of 200", stock: 150 },
  { name: "Adhesive Bandages (Assorted)", category: "Consumables", price: 5, unit: "box of 100", stock: 160 },
  { name: "Medical Tape", category: "Consumables", price: 4, unit: "roll", stock: 130 },
  { name: "Cotton Balls", category: "Consumables", price: 3.5, unit: "bag of 500", stock: 140 },
  { name: "Tongue Depressors", category: "Consumables", price: 3, unit: "box of 500", stock: 150 },

  // Injections & Sample Collection
  { name: "Disposable Syringes (5ml)", category: "Injections & Sampling", price: 9, unit: "box of 100", stock: 120 },
  { name: "Blood Collection Tubes (Assorted)", category: "Injections & Sampling", price: 14, unit: "box of 100", stock: 90 },
  { name: "Vaccine Vials — Saline Diluent", category: "Injections & Sampling", price: 12, unit: "box of 50", stock: 60 },
  { name: "Sharps Disposal Container", category: "Injections & Sampling", price: 11, unit: "each", stock: 80 },

  // PPE & Disposables
  { name: "Nitrile Examination Gloves (M)", category: "PPE & Disposables", price: 9, unit: "box of 100", stock: 300 },
  { name: "3-Ply Face Masks", category: "PPE & Disposables", price: 6, unit: "box of 50", stock: 300 },
  { name: "Disposable Patient Gowns", category: "PPE & Disposables", price: 11, unit: "box of 100", stock: 140 },
  { name: "Examination Table Paper Roll", category: "PPE & Disposables", price: 7, unit: "roll", stock: 150 },
  { name: "Self-Seal Sterilization Pouches", category: "PPE & Disposables", price: 13, unit: "box of 200", stock: 120 },

  // Anesthesia & Medication
  { name: "Lidocaine 2% Injection Vials", category: "Anesthesia & Medication", price: 28, unit: "box of 50", stock: 80 },
  { name: "Topical Anesthetic Cream", category: "Anesthesia & Medication", price: 14, unit: "tube", stock: 70 },

  // Equipment
  { name: "Autoclave Sterilizer (18L)", category: "Equipment", price: 850, unit: "each", stock: 8 },
  { name: "Nebulizer Machine", category: "Equipment", price: 95, unit: "each", stock: 20 },
  { name: "ECG Machine (Portable)", category: "Equipment", price: 650, unit: "each", stock: 6 },
  { name: "Examination Table", category: "Equipment", price: 320, unit: "each", stock: 10 },
  { name: "Weighing Scale (Digital)", category: "Equipment", price: 45, unit: "each", stock: 25 },
];

async function run() {
  await connectDB();

  const email = "vendor@example.com";
  let vendor = await User.findOne({ email });
  if (!vendor) {
    vendor = await User.create({
      name: "MedSupply Co.",
      companyName: "MedSupply Co.",
      email,
      password: "password123", // hashed by the User pre-save hook
      role: "vendor",
      phone: "03009998877",
    });
    console.log(`Created demo vendor: ${email} / password123`);
  } else {
    console.log(`Demo vendor already exists: ${email}`);
  }

  // Replace this vendor's catalog so re-running stays idempotent
  await Product.deleteMany({ vendor: vendor._id });
  const docs = CATALOG.map((p) => ({ ...p, vendor: vendor._id }));
  await Product.insertMany(docs);
  console.log(`Seeded ${docs.length} products across ${new Set(CATALOG.map((c) => c.category)).size} categories.`);

  await mongoose.connection.close();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
