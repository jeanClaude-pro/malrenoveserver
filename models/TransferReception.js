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

    // Links this reception back to the Transfer it fulfills. Unique+sparse so a
    // given transfer can only ever be received once (prevents duplicate receptions),
    // while staying optional for legacy records created before this link existed.
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: "Transfer" },

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
    // A direct reception may legitimately not have the deliverer's details yet.
    // The UI treats this field as optional, so the persistence rule must do the
    // same instead of turning a valid submission into a server error.
    deliveredBy: { type: String, default: "", maxlength: 100 },
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

transferReceptionSchema.pre("validate", function () {
  if (!this.receptionId) this.receptionId = generateReceptionId();
});

transferReceptionSchema.index({ createdAt: -1 });
transferReceptionSchema.index({ status: 1 });
transferReceptionSchema.index({ "product.productId": 1 });
// receptionId already gets a unique index from its field-level `unique: true` above —
// declaring it again here was the cause of the "Duplicate schema index" Mongoose warning.
transferReceptionSchema.index({ transferId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("TransferReception", transferReceptionSchema);
