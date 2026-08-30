import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true },
  },
  { timestamps: true }
);

// One review per client per dentist (a client can update their existing review)
reviewSchema.index({ dentist: 1, client: 1 }, { unique: true });

export default mongoose.model("Review", reviewSchema);
