// models/CarTrip.js
const mongoose = require("mongoose");

const cargoProductSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: { type: String, required: true, trim: true },
    boxesCount: { type: Number, required: true, min: 1 },
    piecesPerBox: { type: Number, required: true, min: 1 },
    totalPieces: { type: Number, required: true, min: 1 },
    weight: { type: Number, min: 0, default: 0 },
    value: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const inventoryItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    piecesPerCarton: { type: Number, required: true, min: 1, default: 1 },
  },
  { _id: false }
);

const carTripSchema = new mongoose.Schema(
  {
    branchId: {
      type: String,
      enum: ["butembo", "beni"],
      default: "butembo",
      index: true,
    },
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
        default: null,
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
    // New trips keep every carried product here. `cargo` remains in place as a
    // legacy single-product snapshot so existing records and older clients keep
    // working.
    products: {
      type: [cargoProductSchema],
      default: undefined,
    },
    // Trip Details
    departureTime: {
      type: Date,
      required: true,
    },
    expectedArrivalTime: {
      type: Date,
      default: null,
    },
    actualArrivalTime: {
      type: Date,
      default: null,
    },
    // Arrival confirmation details (filled when car marks as arrived)
    arrivalDetails: {
      confirmedAt: { type: Date, default: null },
      confirmedBy: { type: String, default: "" },
      receivedBoxes: { type: Number, min: 0, default: 0 },
      receivedPieces: { type: Number, min: 0, default: 0 },
      totalReceivedPieces: { type: Number, min: 0, default: 0 },
      products: { type: [inventoryItemSchema], default: undefined },
      notes: { type: String, trim: true, maxlength: 1000, default: "" },
    },
    // Exact inventory snapshot credited by arrival confirmation. It is used to
    // make confirmation idempotent and to safely reconcile edits/deletions.
    inventoryProcessed: { type: Boolean, default: false },
    inventoryProcessedAt: { type: Date, default: null },
    inventoryItems: { type: [inventoryItemSchema], default: undefined },
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
carTripSchema.pre("save", async function () {
  if (Array.isArray(this.products) && this.products.length > 0) {
    for (const product of this.products) {
      product.totalPieces = product.boxesCount * product.piecesPerBox;
    }

    // Keep the former single-cargo shape populated for backward compatibility.
    const firstProduct = this.products[0];
    this.cargo.productId = firstProduct.productId;
    this.cargo.productName = firstProduct.productName;
    this.cargo.boxesCount = firstProduct.boxesCount;
    this.cargo.piecesPerBox = firstProduct.piecesPerBox;
    this.cargo.totalPieces = firstProduct.totalPieces;
    this.cargo.weight = firstProduct.weight || 0;
    this.cargo.value = firstProduct.value || 0;
  } else if (this.cargo.boxesCount && this.cargo.piecesPerBox) {
    this.cargo.totalPieces = this.cargo.boxesCount * this.cargo.piecesPerBox;
  }
  this.totalCost = (this.fuelCost || 0) + (this.tollCost || 0) + (this.otherCosts || 0);
});

// Indexes for better query performance
// NOTE: tripId already has a unique index from `unique: true` above — no need to redeclare it
carTripSchema.index({ status: 1 });
carTripSchema.index({ departureTime: -1 });
carTripSchema.index({ "driver.phone": 1 });
carTripSchema.index({ "vehicle.plateNumber": 1 });
carTripSchema.index({ createdAt: -1 });

module.exports = mongoose.models.CarTrip || mongoose.model("CarTrip", carTripSchema);
