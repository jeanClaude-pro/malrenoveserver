// routes/transferReceptions.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const TransferReception = require("../models/TransferReception");
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

// ==================== CREATE ====================
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      productId,
      cartonQuantity = 0,
      looseQuantity = 0,
      sourceLocation,
      transferReference,
      deliveredBy,
      receivedBy,
      notes = "",
      operationDate,
    } = req.body;

    if (!productId) return res.status(400).json({ error: "Product is required" });
    if (!sourceLocation || !sourceLocation.trim())
      return res.status(400).json({ error: "Source location is required" });
    if (!transferReference || !transferReference.trim())
      return res.status(400).json({ error: "Transfer reference is required" });
    if (!deliveredBy || !deliveredBy.trim())
      return res.status(400).json({ error: "Delivered by is required" });
    if (!receivedBy || !receivedBy.trim())
      return res.status(400).json({ error: "Received by is required" });

    const product = await Product.findById(productId).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const piecesPerCarton = Math.max(1, Math.floor(Number(product.piecesPerCarton || 1)));
    const cartons = Math.max(0, Math.floor(Number(cartonQuantity)));
    const loose = Math.max(0, Math.floor(Number(looseQuantity)));

    if (loose >= piecesPerCarton) {
      return res.status(400).json({
        error: `Loose pieces must be less than ${piecesPerCarton} per carton`,
      });
    }

    const totalPieces = cartons * piecesPerCarton + loose;
    if (totalPieces <= 0) {
      return res.status(400).json({ error: "Received quantity must be greater than zero" });
    }

    const previousStock = Number(product.stock || 0);
    const newStock = previousStock + totalPieces;

    const session = await mongoose.startSession();
    let reception;
    try {
      session.startTransaction();

      await Product.findByIdAndUpdate(
        productId,
        { $inc: { stock: totalPieces } },
        { session }
      );

      reception = new TransferReception({
        product: {
          productId: new mongoose.Types.ObjectId(productId),
          name: product.name,
          cartonQuantity: cartons,
          looseQuantity: loose,
          piecesPerCarton,
          totalPieces,
        },
        sourceLocation: sourceLocation.trim(),
        transferReference: transferReference.trim(),
        deliveredBy: deliveredBy.trim(),
        receivedBy: receivedBy.trim(),
        notes: String(notes || "").trim(),
        previousStock,
        newStock,
        recordedBy: req.user.name || req.user.username,
        recordedByUserId: req.user._id,
      });

      if (operationDate && req.user.isAdmin) {
        const opDate = new Date(operationDate + "T12:00:00");
        if (!isNaN(opDate.getTime()) && opDate <= new Date()) reception.createdAt = opDate;
      }
      await reception.save({ session });
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
    if (error.name === "CastError") return res.status(400).json({ error: "Invalid product ID" });
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

    const changes = {};
    if (newTotalPieces !== originalPieces)
      changes.totalPieces = { from: originalPieces, to: newTotalPieces };
    if (sourceLocation && sourceLocation !== original.sourceLocation)
      changes.sourceLocation = { from: original.sourceLocation, to: sourceLocation };
    if (transferReference && transferReference !== original.transferReference)
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
          sourceLocation: (sourceLocation || original.sourceLocation).trim(),
          transferReference: (transferReference || original.transferReference).trim(),
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
