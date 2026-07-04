const mongoose = require("mongoose");

function generateReceptionId() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `REC-${year}${month}${day}-${random}`;
}

const editHistorySchema = new mongoose.Schema(
  {
    editedBy: String,
    editedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    editedAt: { type: Date, default: Date.now },
    changes: mongoose.Schema.Types.Mixed,
    reason: String,
  },
  { _id: false }
);

const transferReceptionSchema = new mongoose.Schema(
  {
    receptionId: { type: String, unique: true },

    product: {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
      name: { type: String, required: true, maxlength: 120 },
      cartonQuantity: { type: Number, default: 0, min: 0 },
      looseQuantity: { type: Number, default: 0, min: 0 },
      piecesPerCarton: { type: Number, default: 1, min: 1 },
      totalPieces: { type: Number, required: true, min: 1 },
    },

    sourceLocation: { type: String, required: true, maxlength: 200 },
    transferReference: { type: String, required: true, maxlength: 100 },
    deliveredBy: { type: String, required: true, maxlength: 100 },
    receivedBy: { type: String, required: true, maxlength: 100 },
    notes: { type: String, default: "", maxlength: 500 },

    status: { type: String, enum: ["active", "voided"], default: "active" },

    // Inventory snapshot at time of reception
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },

    // Audit
    recordedBy: String,
    recordedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    editHistory: [editHistorySchema],

    voidedBy: String,
    voidedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    voidedAt: Date,
    voidReason: String,
  },
  { timestamps: true }
);

transferReceptionSchema.pre("validate", function (next) {
  if (!this.receptionId) this.receptionId = generateReceptionId();
  next();
});

transferReceptionSchema.index({ createdAt: -1 });
transferReceptionSchema.index({ status: 1 });
transferReceptionSchema.index({ "product.productId": 1 });
transferReceptionSchema.index({ receptionId: 1 });

module.exports = mongoose.model("TransferReception", transferReceptionSchema);
