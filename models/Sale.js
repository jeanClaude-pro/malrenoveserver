const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: false, // Made optional for expenses
  },
  name: {
    type: String,
    required: false, // Made optional for expenses
  },
  quantity: {
    type: Number,
    required: false, // Made optional for expenses
    min: 1,
  },
  paidQuantity: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  bonusQuantity: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  cartonQuantity: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  looseQuantity: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  bonusCartons: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  bonusPieces: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  piecesPerCarton: {
    type: Number,
    required: false,
    min: 1,
    default: 1,
  },
  boxPrice: {
    type: Number,
    required: false,
    min: 0,
    default: 0,
  },
  price: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0,
  },
  total: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0,
  },
});

const saleSchema = new mongoose.Schema(
  {
    saleId: {
      type: String,
      required: true,
      unique: true, // ← THIS creates an index automatically
    },
    customer: {
      name: {
        type: String,
        required: false, // Made optional for expenses
        trim: true,
      },
      phone: {
        type: String,
        required: false, // Made optional for expenses
        trim: true,
        // REMOVED: index: true  ← Fixed: removed duplicate index
      },
      email: {
        type: String,
        trim: true,
        default: "",
      },
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: false,
    },
    items: [saleItemSchema],
    subtotal: {
      type: Number,
      required: false, // Made optional for expenses
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "transfer", "other"],
      default: "cash",
    },
    saleNumber: {
      type: String,
      unique: true, // ← THIS also creates an index automatically
    },
    salesPerson: {
      type: String,
      required: true,
      trim: true,
      default: "Admin",
    },
    // --- UPDATED STATUS ENUM ---
    status: {
      type: String,
      enum: ["completed", "refunded", "pending", "voided", "corrected", "expense"], // 🔹 Added "expense"
      default: "completed",
    },
    // --- UPDATED TYPE ENUM ---
    type: {
      type: String,
      enum: ["sale", "reservation", "expense"], // 🔹 Added "expense"
      default: "sale",
    },
    // --- NEW EXPENSE FIELDS ---
    reason: {
      type: String,
      required: false, // Will be required for expenses
      trim: true,
    },
    recipientName: {
      type: String,
      required: false, // Will be required for expenses
      trim: true,
    },
    recipientPhone: {
      type: String,
      required: false, // Will be required for expenses
      trim: true,
    },
    // --- EXISTING RESERVATION FIELDS ---
    reservationDate: {
      type: String,
      default: null,
    },
    reservationTime: {
      type: String,
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    completedAt: {
      type: Date,
      default: null,
    },
    completedBy: {
      type: String,
      default: null,
    },
    // --- EXISTING FIELDS ---
    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    voidedAt: {
      type: Date,
      default: null,
    },
    // --- NEW FIELDS FOR SALE CORRECTION ---
    originalSaleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      default: null,
    },
    correctionSaleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      default: null,
    },
    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    editHistory: [
      {
        editedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        editedAt: {
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

// Create index for better query performance
saleSchema.index({ createdAt: -1 });
saleSchema.index({ "customer.phone": 1 }); // Keep this explicit index
// REMOVED: saleSchema.index({ saleId: 1 }); ← DUPLICATE of unique: true on saleId
saleSchema.index({ salesPerson: 1 });
saleSchema.index({ type: 1 }); // Add index for type (sale/reservation/expense)
saleSchema.index({ status: 1 });

// ✅ FIXED: Pre-save middleware (async style — NO next())
saleSchema.pre("save", async function () {
  // Only calculate totals if this is a sale with items
  if (this.type === "sale" && Array.isArray(this.items) && this.items.length > 0) {
    let subtotal = 0;

    this.items.forEach((item) => {
      const price = Number(item.price ?? 0);
      const qty = Number(item.paidQuantity ?? item.quantity ?? 0);
      const piecesPerCarton = Math.max(1, Number(item.piecesPerCarton || 1));

      // Only compute if qty > 0 (and price can be 0)
      if (qty > 0) {
        item.total = price * (qty / piecesPerCarton);
        subtotal += item.total;
      }
    });

    // If subtotal not provided, set it
    if (this.subtotal == null) this.subtotal = subtotal;

    // If total is missing/invalid, set it equal to subtotal
    // (You can remove this if your route always sets total)
    if (this.total == null || Number.isNaN(Number(this.total))) {
      this.total = subtotal;
    }
  }
});

module.exports = mongoose.model("Sale", saleSchema);
