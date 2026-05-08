const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    brand: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    piecesPerCarton: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    minStock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    unit: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
      default: "pcs",
    },
    weight: {
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// Create index for better search performance
productSchema.index({ name: "text", description: "text", brand: "text" });
//productSchema.index({ category: 1 });
productSchema.index({ status: 1 });

// Reuse if it already exists (prevents OverwriteModelError)
const Product =
  mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
