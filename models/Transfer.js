// models/Transfer.js
const mongoose = require("mongoose");

const transferSchema = new mongoose.Schema(
  {
    transferId: {
      type: String,
      required: true,
      unique: true,
    },
    // What is being transferred
    product: {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        default: null,
      },
      name: {
        type: String,
        required: true,
        trim: true,
      },
      cartonQuantity: {
        type: Number,
        required: true,
        min: 0,
        default: 0,
      },
      looseQuantity: {
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
      totalPieces: {
        type: Number,
        required: true,
        min: 0,
      },
    },
    // Where the goods are coming from
    sourceLocation: {
      type: String,
      required: true,
      trim: true,
    },
    // ==================== Transfer Information ====================
    // Destination & receiver
    destinationAgency: {
      type: String,
      required: true,
      trim: true,
    },
    receiver: {
      name: {
        type: String,
        trim: true,
        default: "",
      },
      phone: {
        type: String,
        trim: true,
        default: "",
      },
    },
    // Transport details
    transport: {
      driverName: {
        type: String,
        trim: true,
        default: "",
      },
      vehiclePlate: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
      },
      transportCompany: {
        type: String,
        trim: true,
        default: "",
      },
      deliveryNotes: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: "",
      },
    },
    // ================================================================
    status: {
      type: String,
      enum: ["pending", "in_transit", "delivered", "cancelled"],
      default: "pending",
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    deliveryConfirmedBy: {
      type: String,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    // Audit
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
      default: null,
    },
    lastModifiedByName: {
      type: String,
      default: "",
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

// Compute total pieces from cartons + loose pieces
transferSchema.pre("save", async function () {
  if (this.product) {
    const piecesPerCarton = Math.max(1, Number(this.product.piecesPerCarton || 1));
    this.product.totalPieces =
      Number(this.product.cartonQuantity || 0) * piecesPerCarton +
      Number(this.product.looseQuantity || 0);
  }
});

transferSchema.index({ status: 1 });
transferSchema.index({ destinationAgency: 1 });
transferSchema.index({ "transport.vehiclePlate": 1 });
transferSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.Transfer || mongoose.model("Transfer", transferSchema);
