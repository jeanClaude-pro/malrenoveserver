// models/CarTrip.js
const mongoose = require("mongoose");

const carTripSchema = new mongoose.Schema(
  {
    tripId: {
      type: String,
      required: true,
      unique: true,
    },
    // Origin & Destination
    origin: {
      type: String,
      required: true,
      trim: true,
    },
    destination: {
      type: String,
      required: true,
      trim: true,
    },
    // Driver Information
    driver: {
      name: {
        type: String,
        required: true,
        trim: true,
      },
      phone: {
        type: String,
        required: true,
        trim: true,
      },
      licenseNumber: {
        type: String,
        trim: true,
      },
    },
    // Vehicle Information
    vehicle: {
      plateNumber: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
      },
      model: {
        type: String,
        trim: true,
      },
      capacity: {
        type: Number, // in tons or cubic meters
        min: 0,
      },
    },
    // Cargo Information
    cargo: {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
      },
      productName: {
        type: String,
        required: true,
      },
      boxesCount: {
        type: Number,
        required: true,
        min: 1,
      },
      piecesPerBox: {
        type: Number,
        required: true,
        min: 1,
      },
      totalPieces: {
        type: Number,
        required: true,
      },
      weight: {
        type: Number, // in kg
        min: 0,
      },
      value: {
        type: Number, // estimated value in USD
        min: 0,
      },
    },
    // Trip Details
    departureTime: {
      type: Date,
      required: true,
    },
    expectedArrivalTime: {
      type: Date,
      required: true,
    },
    actualArrivalTime: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["planned", "en_route", "delayed", "arrived", "cancelled", "completed"],
      default: "planned",
    },
    // Tracking
    currentLocation: {
      type: String,
      trim: true,
    },
    lastUpdate: {
      type: Date,
      default: Date.now,
    },
    // Financial
    fuelCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    tollCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    otherCosts: {
      type: Number,
      min: 0,
      default: 0,
    },
    totalCost: {
      type: Number,
      min: 0,
      default: 0,
    },
    // Additional Info
    notes: {
      type: String,
      trim: true,
    },
    // Security & Audit
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdByName: {
      type: String,
      required: true,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    lastModifiedByName: {
      type: String,
    },
    editHistory: [
      {
        modifiedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        modifiedByName: String,
        modifiedAt: {
          type: Date,
          default: Date.now,
        },
        changes: {
          type: Map,
          of: mongoose.Schema.Types.Mixed,
        },
        reason: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Pre-save middleware to calculate total pieces and total cost
carTripSchema.pre("save", function (next) {
  // Calculate total pieces
  if (this.cargo.boxesCount && this.cargo.piecesPerBox) {
    this.cargo.totalPieces = this.cargo.boxesCount * this.cargo.piecesPerBox;
  }
  
  // Calculate total cost
  this.totalCost = (this.fuelCost || 0) + (this.tollCost || 0) + (this.otherCosts || 0);
  
  next();
});

// Indexes for better query performance
carTripSchema.index({ tripId: 1 });
carTripSchema.index({ status: 1 });
carTripSchema.index({ departureTime: -1 });
carTripSchema.index({ "driver.phone": 1 });
carTripSchema.index({ "vehicle.plateNumber": 1 });
carTripSchema.index({ createdAt: -1 });

module.exports = mongoose.model("CarTrip", carTripSchema);