const mongoose = require("mongoose");

const stockMovementSchema = new mongoose.Schema(
  {
    branchId: {
      type: String,
      enum: ["butembo", "beni"],
      default: "butembo",
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["loan", "loan_return", "bonus_manual", "adjustment_in", "adjustment_out", "car_arrival", "transfer_out", "sale", "reception"],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    piecesPerCarton: {
      type: Number,
      default: 1,
      min: 1,
    },
    // For loan type: customer info
    loanCustomer: {
      type: String,
      trim: true,
      default: "",
    },
    loanCustomerPhone: {
      type: String,
      trim: true,
      default: "",
    },
    loanPaid: {
      type: Boolean,
      default: false,
    },
    loanPaidAt: {
      type: Date,
      default: null,
    },
    loanPaidBy: {
      type: String,
      default: null,
    },
    // Optional reference (sale ID, order number, etc.)
    reference: {
      type: String,
      trim: true,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    recordedBy: {
      type: String,
      required: true,
      trim: true,
    },
    recordedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    recordedByRole: { type: String, trim: true, default: "" },
    previousStock: { type: Number, min: 0, default: undefined },
    newStock: { type: Number, min: 0, default: undefined },
  },
  {
    timestamps: true,
  }
);

stockMovementSchema.index({ productId: 1, createdAt: -1 });
stockMovementSchema.index({ type: 1 });
stockMovementSchema.index({ loanPaid: 1 });
stockMovementSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.StockMovement ||
  mongoose.model("StockMovement", stockMovementSchema);
