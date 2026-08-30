/**
 * Seeds a demo vendor and a catalog of common dental supplies.
 * Run from the server/ directory:  node seed/seedProducts.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Product from "../models/Product.js";

// Common items a dental clinic uses day to day, grouped by category.
// price is illustrative (USD); unit reflects how the item is usually sold.
const CATALOG = [
  // Instruments
  { name: "Dental Mouth Mirror (Plane, #5)", category: "Instruments", price: 3.5, unit: "each", stock: 200 },
  { name: "Dental Explorer / Probe (Double-ended)", category: "Instruments", price: 4, unit: "each", stock: 150 },
  { name: "College Tweezers (Cotton Pliers)", category: "Instruments", price: 5, unit: "each", stock: 120 },
  { name: "Periodontal Probe (UNC-15)", category: "Instruments", price: 6, unit: "each", stock: 100 },
  { name: "Sickle Scaler", category: "Instruments", price: 7.5, unit: "each", stock: 90 },
  { name: "Gracey Curette (Set of 4)", category: "Instruments", price: 32, unit: "set", stock: 40 },
  { name: "Spoon Excavator", category: "Instruments", price: 5.5, unit: "each", stock: 80 },
  { name: "Extraction Forceps (Upper Universal)", category: "Instruments", price: 18, unit: "each", stock: 60 },
  { name: "Dental Elevator (Straight)", category: "Instruments", price: 14, unit: "each", stock: 60 },
  { name: "Amalgam Condenser", category: "Instruments", price: 8, unit: "each", stock: 70 },

  // Restorative & Consumables
  { name: "Composite Resin Kit (Light-Cure, A2)", category: "Restorative", price: 65, unit: "kit", stock: 50 },
  { name: "Glass Ionomer Cement (GIC)", category: "Restorative", price: 40, unit: "pack", stock: 55 },
  { name: "Dental Amalgam Capsules", category: "Restorative", price: 70, unit: "box of 50", stock: 45 },
  { name: "Bonding Agent / Adhesive (5ml)", category: "Restorative", price: 38, unit: "bottle", stock: 60 },
  { name: "Phosphoric Acid Etchant Gel (37%)", category: "Restorative", price: 12, unit: "syringe", stock: 90 },
  { name: "Temporary Filling Material", category: "Restorative", price: 15, unit: "jar", stock: 70 },
  { name: "Matrix Bands & Wedges Assortment", category: "Restorative", price: 9, unit: "pack", stock: 100 },

  // Endodontics
  { name: "Endodontic K-Files (Assorted #15-40)", category: "Endodontics", price: 11, unit: "pack of 6", stock: 120 },
  { name: "Gutta Percha Points (Assorted)", category: "Endodontics", price: 8, unit: "box", stock: 110 },
  { name: "Paper Points (Absorbent)", category: "Endodontics", price: 6, unit: "box", stock: 130 },
  { name: "Barbed Broaches", category: "Endodontics", price: 5, unit: "pack", stock: 90 },

  // Rotary / Burs
  { name: "Diamond Burs (Assorted FG)", category: "Rotary & Burs", price: 22, unit: "pack of 10", stock: 80 },
  { name: "Carbide Burs (Assorted)", category: "Rotary & Burs", price: 18, unit: "pack of 10", stock: 80 },

  // PPE & Disposables
  { name: "Nitrile Examination Gloves (M)", category: "PPE & Disposables", price: 9, unit: "box of 100", stock: 300 },
  { name: "3-Ply Face Masks", category: "PPE & Disposables", price: 6, unit: "box of 50", stock: 300 },
  { name: "Saliva Ejectors", category: "PPE & Disposables", price: 7, unit: "bag of 100", stock: 200 },
  { name: "Cotton Rolls (#2 Medium)", category: "PPE & Disposables", price: 8, unit: "box of 1000", stock: 150 },
  { name: "Disposable Patient Bibs", category: "PPE & Disposables", price: 11, unit: "box of 500", stock: 140 },
  { name: "Self-Seal Sterilization Pouches", category: "PPE & Disposables", price: 13, unit: "box of 200", stock: 120 },

  // Anesthesia
  { name: "Lidocaine 2% with Epinephrine Cartridges", category: "Anesthesia", price: 28, unit: "box of 50", stock: 80 },
  { name: "Dental Needles (27G Short)", category: "Anesthesia", price: 16, unit: "box of 100", stock: 90 },
  { name: "Topical Anesthetic Gel (Benzocaine 20%)", category: "Anesthesia", price: 14, unit: "jar", stock: 70 },

  // Equipment
  { name: "High-Speed Handpiece (Push-Button)", category: "Equipment", price: 180, unit: "each", stock: 25 },
  { name: "Low-Speed Handpiece Motor", category: "Equipment", price: 150, unit: "each", stock: 25 },
  { name: "LED Curing Light (Cordless)", category: "Equipment", price: 120, unit: "each", stock: 30 },
  { name: "Ultrasonic Scaler Unit", category: "Equipment", price: 260, unit: "each", stock: 15 },
  { name: "Autoclave Sterilizer (18L)", category: "Equipment", price: 850, unit: "each", stock: 8 },
  { name: "Apex Locator", category: "Equipment", price: 210, unit: "each", stock: 12 },

  // Prophylaxis / Hygiene
  { name: "Prophy Paste (Mint, Medium Grit)", category: "Prophylaxis", price: 17, unit: "box of 200", stock: 100 },
  { name: "Prophy Cups (Snap-on)", category: "Prophylaxis", price: 10, unit: "bag of 144", stock: 110 },
  { name: "Fluoride Varnish (5% NaF)", category: "Prophylaxis", price: 35, unit: "box of 50", stock: 70 },

  // Orthodontics
  { name: "Metal Brackets (Roth .022, Full Case)", category: "Orthodontics", price: 25, unit: "case", stock: 60 },
  { name: "NiTi Archwires (Assorted)", category: "Orthodontics", price: 20, unit: "pack of 10", stock: 80 },
  { name: "Elastic Ligature Ties", category: "Orthodontics", price: 8, unit: "stick of 1000", stock: 120 },
];

async function run() {
  await connectDB();

  const email = "vendor@example.com";
  let vendor = await User.findOne({ email });
  if (!vendor) {
    vendor = await User.create({
      name: "DentSupply Co.",
      companyName: "DentSupply Co.",
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
