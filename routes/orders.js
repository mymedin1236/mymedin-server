import express from "express";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.use(protect);

// POST /api/orders (doctor) -> place an order from a cart.
// Body: { items: [{ product, quantity }], notes }
// A cart may span multiple vendors, so we split it into one order per vendor.
router.post("/", requireRole("doctor"), async (req, res) => {
  try {
    const { items, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    const ids = items.map((i) => i.product);
    const products = await Product.find({ _id: { $in: ids } });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    // Group requested items by their vendor
    const byVendor = new Map();
    for (const item of items) {
      const product = byId.get(String(item.product));
      if (!product) continue;
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const vendorId = String(product.vendor);
      if (!byVendor.has(vendorId)) byVendor.set(vendorId, []);
      byVendor.get(vendorId).push({
        product: product._id,
        name: product.name,
        price: product.price,
        quantity: qty,
      });
    }

    if (byVendor.size === 0) {
      return res.status(400).json({ message: "No valid products in cart" });
    }

    const created = [];
    for (const [vendorId, vendorItems] of byVendor) {
      const total = vendorItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
      const order = await Order.create({
        doctor: req.user._id,
        vendor: vendorId,
        items: vendorItems,
        total,
        notes,
      });
      created.push(order);
    }

    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/orders -> doctor sees orders they placed; vendor sees orders for their products
router.get("/", async (req, res) => {
  try {
    const filter =
      req.user.role === "vendor"
        ? { vendor: req.user._id }
        : { doctor: req.user._id };
    const orders = await Order.find(filter)
      .populate("vendor", "name companyName")
      .populate("doctor", "name clinicName")
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/orders/:id/status (vendor) -> advance/cancel an order they own
router.patch("/:id/status", requireRole("vendor"), async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ["pending", "confirmed", "shipped", "delivered", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, vendor: req.user._id },
      { status },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
