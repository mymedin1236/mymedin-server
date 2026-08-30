import express from "express";
import mongoose from "mongoose";
import Product from "../models/Product.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.use(protect);

// GET /api/products?search=&category=&mine=true
// Dentists browse the catalog; vendors can pass mine=true to get their own listings.
router.get("/", async (req, res) => {
  try {
    const { search, category, mine } = req.query;
    const filter = {};
    if (mine === "true") filter.vendor = req.user._id;
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { name: new RegExp(search, "i") },
        { description: new RegExp(search, "i") },
        { category: new RegExp(search, "i") },
      ];
    }
    const products = await Product.find(filter)
      .populate("vendor", "name companyName")
      .sort({ category: 1, name: 1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/products/categories -> distinct category list (for filter dropdown)
router.get("/categories", async (req, res) => {
  const categories = await Product.distinct("category");
  res.json(categories.filter(Boolean).sort());
});

// POST /api/products (vendor) -> create a listing
router.post("/", requireRole("vendor"), async (req, res) => {
  try {
    const { name, description, category, price, unit, stock } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ message: "name and price are required" });
    }
    const product = await Product.create({
      vendor: req.user._id,
      name,
      description,
      category,
      price,
      unit,
      stock,
    });
    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/products/:id (vendor, own listing)
router.put("/:id", requireRole("vendor"), async (req, res) => {
  try {
    const { name, description, category, price, unit, stock } = req.body;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, vendor: req.user._id },
      { name, description, category, price, unit, stock },
      { new: true }
    );
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/products/:id (vendor, own listing)
router.delete("/:id", requireRole("vendor"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Product not found" });
  }
  const product = await Product.findOneAndDelete({
    _id: req.params.id,
    vendor: req.user._id,
  });
  if (!product) return res.status(404).json({ message: "Product not found" });
  res.json({ message: "Deleted" });
});

export default router;
