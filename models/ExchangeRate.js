const mongoose = require("mongoose");
const { branchScope } = require("../utils/branchContext");

const exchangeRateSchema = new mongoose.Schema({
  branchId: {
    type: String,
    enum: ["butembo", "beni"],
    default: "butembo",
    index: true,
  },
  rate: {
    type: Number,
    required: true,
    min: 0.0001, // Very small positive number
    description: "FC to USD rate (e.g., 2500 means 1 USD = 2500 FC)"
  },
  effectiveFrom: {
    type: Date,
    default: Date.now,
    description: "When this rate becomes active"
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  isActive: {
    type: Boolean,
    default: true,
    description: "Only one active rate at a time"
  },
  notes: {
    type: String,
    maxlength: 500,
    description: "Optional notes about rate change"
  }
}, {
  timestamps: true
});

// Index for efficient queries
exchangeRateSchema.index({ isActive: 1 });
exchangeRateSchema.index({ effectiveFrom: -1 });
exchangeRateSchema.index({ branchId: 1, isActive: 1 });

// Static method to get current active rate for a branch
exchangeRateSchema.statics.getCurrentRate = function(branchId) {
  return this.findOne({ $and: [{ isActive: true }, branchScope(branchId)] }).sort({ effectiveFrom: -1 });
};

// Static method to get rate history for a branch
exchangeRateSchema.statics.getRateHistory = function(limit = 50, branchId) {
  return this.find(branchScope(branchId)).sort({ effectiveFrom: -1 }).limit(limit).populate('createdBy', 'username email');
};

// Static method to get the rate that was active on a given date, for a branch
exchangeRateSchema.statics.getRateForDate = function(date, branchId) {
  return this.findOne({ $and: [{ effectiveFrom: { $lte: new Date(date) } }, branchScope(branchId)] }).sort({ effectiveFrom: -1 });
};

// Instance method to deactivate this rate
exchangeRateSchema.methods.deactivate = function() {
  this.isActive = false;
  return this.save();
};

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);