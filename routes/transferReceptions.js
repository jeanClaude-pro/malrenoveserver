// routes/transferReceptions.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const TransferReception = require("../models/TransferReception");
const Transfer = require("../models/Transfer");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");

function buildTimeframeFilter(query) {
  const { from, to, date, year, month } = query;

  if (from || to) {
    const startDate = from ? new Date(from) : new Date(0);
    const endDate = to ? new Date(to) : new Date();
    startDate.setHours(0, 0, 0, 0);
    if (to) endDate.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: startDate, $lte: endDate } };
  }

  if (date) {
    const d = new Date(date);
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: start, $lte: end } };
  }

  if (year && month) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10) - 1;
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: start, $lte: end } };
  }

  if (year) {
    const y = parseInt(year, 10);
    const start = new Date(y, 0, 1);
    const end = new Date(y, 11, 31);
    end.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: start, $lte: end } };
  }

  // Default: today
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { createdAt: { $gte: start, $lte: end } };
}

// ==================== GET ALL ====================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};

    try {
      Object.assign(filter, buildTimeframeFilter(req.query));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { receptionId: { $regex: search, $options: "i" } },
        { "product.name": { $regex: search, $options: "i" } },
        { sourceLocation: { $regex: search, $options: "i" } },
        { transferReference: { $regex: search, $options: "i" } },
        { deliveredBy: { $regex: search, $options: "i" } },
        { receivedBy: { $regex: search, $options: "i" } },
      ];
    }

    const receptions = await TransferReception.find(filter).sort({ createdAt: -1 }).lean();

    const activeReceptions = receptions.filter((r) => r.status === "active");
    const summary = {
      total: receptions.length,
      active: activeReceptions.length,
      voided: receptions.filter((r) => r.status === "voided").length,
      totalPiecesReceived: activeReceptions.reduce((sum, r) => sum + r.product.totalPieces, 0),
    };

    res.json({ success: true, data: receptions, summary });
  } catch (error) {
    console.error("Error fetching receptions:", error);
    res.status(500).json({ error: "Failed to fetch receptions" });
  }
});

// ==================== GET ONE ====================
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const reception = await TransferReception.findById(req.params.id).lean();
    if (!reception) return res.status(404).json({ error: "Reception not found" });
    res.json({ success: true, data: reception });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid ID" });
    res.status(500).json({ error: "Failed to fetch reception" });
  }
});

// ==================== CREATE (receive a pending transfer, or record a direct reception) ====================
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      transferId,
      productId,
      sourceLocation,
      transferReference,
      cartonQuantity,
      looseQuantity,
      deliveredBy,
      receivedBy,
      notes = "",
      operationDate,
    } = req.body;

    if (!receivedBy || !receivedBy.trim())
      return res.status(400).json({ error: "Received by is required" });

    // Two ways to record a reception:
    //  - linked to a pending Transfer (transferId given): product/source come from that transfer.
    //  - direct (no transferId): the receiver picks the product from inventory themselves and
    //    supplies where it came from — no prior Transfer record required.
    let transfer = null;
    let effectiveProductId;
    let productName;
    let piecesPerCarton;
    let cartons;
    let loose;
    let effectiveSourceLocation;
    let effectiveTransferReference;
    let effectiveDeliveredBy;

    if (transferId) {
      transfer = await Transfer.findById(transferId);
      if (!transfer) return res.status(404).json({ error: "Transfer not found" });

      if (transfer.status === "cancelled") {
        return res.status(400).json({ error: "This transfer was cancelled and cannot be received" });
      }
      if (transfer.status === "delivered") {
        return res.status(409).json({ error: "This transfer has already been received" });
      }

      effectiveProductId = transfer.product?.productId;
      if (!effectiveProductId) {
        return res.status(400).json({ error: "This transfer has no linked inventory product and cannot be received automatically" });
      }

      piecesPerCarton = Math.max(1, Math.floor(Number(transfer.product.piecesPerCarton || 1)));
      // Default to exactly what was sent; the receiver can override to record a discrepancy.
      cartons = Math.max(
        0,
        Math.floor(Number(cartonQuantity !== undefined ? cartonQuantity : transfer.product.cartonQuantity))
      );
      loose = Math.max(
        0,
        Math.floor(Number(looseQuantity !== undefined ? looseQuantity : transfer.product.looseQuantity))
      );
      productName = transfer.product.name;
      effectiveSourceLocation = transfer.sourceLocation;
      effectiveTransferReference = transfer.transferId;
      effectiveDeliveredBy = (deliveredBy && deliveredBy.trim()) || transfer.transport?.driverName || transfer.transport?.transportCompany || "";
    } else {
      if (!productId) return res.status(400).json({ error: "Please select the product being received" });
      if (!sourceLocation || !sourceLocation.trim()) {
        return res.status(400).json({ error: "Please indicate where this delivery came from" });
      }

      const directProduct = await Product.findById(productId).lean();
      if (!directProduct) return res.status(404).json({ error: "Product not found" });

      effectiveProductId = productId;
      piecesPerCarton = Math.max(1, Math.floor(Number(directProduct.piecesPerCarton || 1)));
      cartons = Math.max(0, Math.floor(Number(cartonQuantity || 0)));
      loose = Math.max(0, Math.floor(Number(looseQuantity || 0)));
      productName = directProduct.name;
      effectiveSourceLocation = sourceLocation.trim();
      effectiveTransferReference = (transferReference && transferReference.trim()) || "Réception directe";
      effectiveDeliveredBy = (deliveredBy && deliveredBy.trim()) || "";
    }

    if (loose >= piecesPerCarton) {
      return res.status(400).json({
        error: `Loose pieces must be less than ${piecesPerCarton} per carton`,
      });
    }

    const totalPieces = cartons * piecesPerCarton + loose;
    if (totalPieces <= 0) {
      return res.status(400).json({ error: "Received quantity must be greater than zero" });
    }

    const product = await Product.findById(effectiveProductId).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const previousStock = Number(product.stock || 0);
    const newStock = previousStock + totalPieces;
    const receivedByName = receivedBy.trim();

    const session = await mongoose.startSession();
    let reception;
    try {
      session.startTransaction();

      await Product.findByIdAndUpdate(
        effectiveProductId,
        { $inc: { stock: totalPieces } },
        { session }
      );

      reception = new TransferReception({
        transferId: transfer ? transfer._id : undefined,
        product: {
          productId: effectiveProductId,
          name: productName,
          cartonQuantity: cartons,
          looseQuantity: loose,
          piecesPerCarton,
          totalPieces,
        },
        sourceLocation: effectiveSourceLocation,
        transferReference: effectiveTransferReference,
        deliveredBy: effectiveDeliveredBy,
        receivedBy: receivedByName,
        notes: String(notes || "").trim(),
        previousStock,
        newStock,
        recordedBy: req.user.name || req.user.username,
        recordedByUserId: req.user.userId || req.user._id,
      });

      if (operationDate && req.user.isAdmin) {
        const opDate = new Date(operationDate + "T12:00:00");
        if (!isNaN(opDate.getTime()) && opDate <= new Date()) reception.createdAt = opDate;
      }
      await reception.save({ session });

      if (transfer) {
        const previousTransferStatus = transfer.status;
        transfer.status = "delivered";
        transfer.deliveredAt = reception.createdAt || new Date();
        transfer.deliveryConfirmedBy = receivedByName;
        transfer.lastModifiedBy = req.user.userId;
        transfer.lastModifiedByName = req.user.name || req.user.username || "Unknown";
        transfer.editHistory.push({
          modifiedBy: req.user.userId,
          modifiedByName: req.user.name || req.user.username || "Unknown",
          modifiedAt: new Date(),
          changes: { status: { from: previousTransferStatus, to: "delivered" } },
          reason: `Received via reception ${reception.receptionId}`,
        });
        await transfer.save({ session });
      }

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    res.status(201).json({ success: true, data: reception });
  } catch (error) {
    console.error("Error creating reception:", error);
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid transfer or product ID" });
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((validationError) => validationError.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (error.code === 11000) {
      return res.status(409).json({ error: "This transfer has already been received" });
    }
    res.status(500).json({ error: "Failed to create reception" });
  }
});

// ==================== EDIT ====================
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const original = await TransferReception.findById(req.params.id).lean();
    if (!original) return res.status(404).json({ error: "Reception not found" });
    if (original.status === "voided") {
      return res.status(400).json({ error: "Cannot edit a voided reception" });
    }

    const {
      cartonQuantity,
      looseQuantity,
      sourceLocation,
      transferReference,
      deliveredBy,
      receivedBy,
      notes,
      reason,
    } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "Reason for edit is required" });
    }

    const product = await Product.findById(original.product.productId).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const piecesPerCarton = Math.max(
      1,
      Math.floor(Number(original.product.piecesPerCarton || product.piecesPerCarton || 1))
    );
    const newCartons = Math.max(
      0,
      Math.floor(Number(cartonQuantity !== undefined ? cartonQuantity : original.product.cartonQuantity))
    );
    const newLoose = Math.max(
      0,
      Math.floor(Number(looseQuantity !== undefined ? looseQuantity : original.product.looseQuantity))
    );

    if (newLoose >= piecesPerCarton) {
      return res.status(400).json({
        error: `Loose pieces must be less than ${piecesPerCarton} per carton`,
      });
    }

    const newTotalPieces = newCartons * piecesPerCarton + newLoose;
    if (newTotalPieces <= 0) {
      return res.status(400).json({ error: "Received quantity must be greater than zero" });
    }

    const originalPieces = original.product.totalPieces;
    const netAdjustment = newTotalPieces - originalPieces;
    const currentStock = Number(product.stock || 0);

    // Ensure reversing original + applying new won't make stock negative
    if (currentStock - originalPieces + newTotalPieces < 0) {
      return res.status(400).json({
        error: "This edit would make inventory negative. Cannot proceed.",
      });
    }

    // When a reception is linked to a real Transfer, its source location and transfer
    // reference must keep matching that transfer's own records — only the physically
    // counted quantity and the people involved can be corrected here.
    const lockLocationFields = !!original.transferId;
    const effectiveSourceLocation = lockLocationFields ? original.sourceLocation : (sourceLocation || original.sourceLocation);
    const effectiveTransferReference = lockLocationFields ? original.transferReference : (transferReference || original.transferReference);

    const changes = {};
    if (newTotalPieces !== originalPieces)
      changes.totalPieces = { from: originalPieces, to: newTotalPieces };
    if (!lockLocationFields && sourceLocation && sourceLocation !== original.sourceLocation)
      changes.sourceLocation = { from: original.sourceLocation, to: sourceLocation };
    if (!lockLocationFields && transferReference && transferReference !== original.transferReference)
      changes.transferReference = { from: original.transferReference, to: transferReference };
    if (deliveredBy && deliveredBy !== original.deliveredBy)
      changes.deliveredBy = { from: original.deliveredBy, to: deliveredBy };
    if (receivedBy && receivedBy !== original.receivedBy)
      changes.receivedBy = { from: original.receivedBy, to: receivedBy };

    // Recalculate stock snapshot: stock before original reception = currentStock - originalPieces
    const stockBeforeOriginal = currentStock - originalPieces;
    const updatedNewStock = stockBeforeOriginal + newTotalPieces;

    const session = await mongoose.startSession();
    let updated;
    try {
      session.startTransaction();

      if (netAdjustment !== 0) {
        if (netAdjustment < 0) {
          const updatedProduct = await Product.findOneAndUpdate(
            { _id: original.product.productId, stock: { $gte: -netAdjustment } },
            { $inc: { stock: netAdjustment } },
            { new: true, session }
          );
          if (!updatedProduct) {
            await session.abortTransaction();
            await session.endSession();
            return res.status(400).json({
              error: "Insufficient stock to adjust inventory after edit",
            });
          }
        } else {
          await Product.findByIdAndUpdate(
            original.product.productId,
            { $inc: { stock: netAdjustment } },
            { session }
          );
        }
      }

      updated = await TransferReception.findByIdAndUpdate(
        req.params.id,
        {
          "product.cartonQuantity": newCartons,
          "product.looseQuantity": newLoose,
          "product.totalPieces": newTotalPieces,
          sourceLocation: effectiveSourceLocation.trim(),
          transferReference: effectiveTransferReference.trim(),
          deliveredBy: (deliveredBy || original.deliveredBy).trim(),
          receivedBy: (receivedBy || original.receivedBy).trim(),
          notes: notes !== undefined ? String(notes).trim() : original.notes,
          previousStock: stockBeforeOriginal,
          newStock: updatedNewStock,
          $push: {
            editHistory: {
              editedBy: req.user.name || req.user.username,
              editedByUserId: req.user._id,
              editedAt: new Date(),
              changes,
              reason: reason.trim(),
            },
          },
        },
        { new: true, session }
      );

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("Error editing reception:", error);
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid ID" });
    res.status(500).json({ error: "Failed to edit reception" });
  }
});

// ==================== VOID ====================
router.patch("/:id/void", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ error: "Only admin or manager can void receptions" });
    }

    const reception = await TransferReception.findById(req.params.id).lean();
    if (!reception) return res.status(404).json({ error: "Reception not found" });
    if (reception.status === "voided") {
      return res.status(400).json({ error: "Reception is already voided" });
    }

    const { reason } = req.body;

    const product = await Product.findById(reception.product.productId).lean();
    if (product && Number(product.stock) < reception.product.totalPieces) {
      return res.status(400).json({
        error: `Cannot void: current stock (${product.stock}) is less than received quantity (${reception.product.totalPieces}). Inventory would go negative.`,
      });
    }

    const session = await mongoose.startSession();
    let voided;
    try {
      session.startTransaction();

      await Product.findByIdAndUpdate(
        reception.product.productId,
        { $inc: { stock: -reception.product.totalPieces } },
        { session }
      );

      voided = await TransferReception.findByIdAndUpdate(
        req.params.id,
        {
          status: "voided",
          voidedBy: req.user.name || req.user.username,
          voidedByUserId: req.user._id,
          voidedAt: new Date(),
          voidReason: reason || "Voided",
          $push: {
            editHistory: {
              editedBy: req.user.name || req.user.username,
              editedByUserId: req.user._id,
              editedAt: new Date(),
              changes: { status: { from: "active", to: "voided" } },
              reason: reason || "Reception voided",
            },
          },
        },
        { new: true, session }
      );

      // The transfer this reception fulfilled is no longer actually received —
      // put it back in transit so it reappears as pending reception.
      if (reception.transferId) {
        await Transfer.findOneAndUpdate(
          { _id: reception.transferId, status: "delivered" },
          {
            status: "in_transit",
            deliveredAt: null,
            deliveryConfirmedBy: "",
            $push: {
              editHistory: {
                modifiedBy: req.user._id,
                modifiedByName: req.user.name || req.user.username || "Unknown",
                modifiedAt: new Date(),
                changes: { status: { from: "delivered", to: "in_transit" } },
                reason: `Reception ${reception.receptionId} was voided: ${reason || "Voided"}`,
              },
            },
          },
          { session }
        );
      }

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    res.json({ success: true, data: voided });
  } catch (error) {
    console.error("Error voiding reception:", error);
    res.status(500).json({ error: "Failed to void reception" });
  }
});

// ==================== DELETE ====================
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admin can delete receptions" });
    }

    const reception = await TransferReception.findById(req.params.id).lean();
    if (!reception) return res.status(404).json({ error: "Reception not found" });

    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      if (reception.status === "active") {
        const product = await Product.findById(reception.product.productId).lean();
        if (product && Number(product.stock) < reception.product.totalPieces) {
          await session.abortTransaction();
          await session.endSession();
          return res.status(400).json({
            error: `Cannot delete: current stock (${product.stock}) is less than received quantity (${reception.product.totalPieces}). Inventory would go negative.`,
          });
        }

        await Product.findByIdAndUpdate(
          reception.product.productId,
          { $inc: { stock: -reception.product.totalPieces } },
          { session }
        );

        if (reception.transferId) {
          await Transfer.findOneAndUpdate(
            { _id: reception.transferId, status: "delivered" },
            {
              status: "in_transit",
              deliveredAt: null,
              deliveryConfirmedBy: "",
              $push: {
                editHistory: {
                  modifiedBy: req.user._id,
                  modifiedByName: req.user.name || req.user.username || "Unknown",
                  modifiedAt: new Date(),
                  changes: { status: { from: "delivered", to: "in_transit" } },
                  reason: `Reception ${reception.receptionId} was deleted`,
                },
              },
            },
            { session }
          );
        }
      }

      await TransferReception.findByIdAndDelete(req.params.id).session(session);

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    res.json({ success: true, message: "Reception deleted successfully" });
  } catch (error) {
    console.error("Error deleting reception:", error);
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid ID" });
    res.status(500).json({ error: "Failed to delete reception" });
  }
});

module.exports = router;
