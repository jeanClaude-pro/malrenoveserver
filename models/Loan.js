const mongoose = require("mongoose");

const loanSchema = new mongoose.Schema(
  {
    loanId: {
      type: String,
      required: true,
      unique: true,
    },
    borrowerName: {
      type: String,
      required: true,
      trim: true,
    },
    borrowerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "partial", "paid", "overdue"],
      default: "pending",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    recordedBy: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

loanSchema.index({ status: 1 });
loanSchema.index({ dueDate: 1 });

module.exports = mongoose.models.Loan || mongoose.model("Loan", loanSchema);
