import express from "express";
import cloudinary, { cloudinaryReady } from "../config/cloudinary.js";

const router = express.Router();

// POST /api/uploads/avatar  { image: "data:image/jpeg;base64,..." } -> { url }
//
// Public on purpose: a doctor uploads their photo during registration, before an
// account (and token) exists. The client crops/zooms to a small square first, so
// the payload is modest. We re-process on Cloudinary's side to a 512×512 square as
// a safety net and to normalise format/quality.
router.post("/avatar", async (req, res) => {
  try {
    const { image } = req.body || {};
    if (
      !image ||
      typeof image !== "string" ||
      !/^data:image\/(png|jpe?g|webp);base64,/.test(image)
    ) {
      return res.status(400).json({ message: "A valid image is required." });
    }
    // base64 is ~33% larger than the raw bytes; cap at ~8MB of encoded text.
    if (image.length > 8 * 1024 * 1024) {
      return res.status(413).json({ message: "Image is too large. Please use a smaller photo." });
    }
    if (!cloudinaryReady()) {
      return res.status(503).json({ message: "Image uploads are not configured on the server." });
    }
    const result = await cloudinary.uploader.upload(image, {
      folder: "mymedin/avatars",
      resource_type: "image",
      format: "jpg",
      transformation: [
        { width: 512, height: 512, crop: "fill", gravity: "auto" },
        { quality: "auto" },
      ],
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error("avatar upload failed:", err);
    res.status(500).json({ message: "Upload failed. Please try again." });
  }
});

export default router;
