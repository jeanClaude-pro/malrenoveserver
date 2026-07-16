// routes/transfers.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Transfer = require("../models/Transfer");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const TransferReception = require("../models/TransferReception");
const authMiddleware = require("../middleware/auth");

// Helper function to generate a unique transfer ID
function generateTransferId() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `TRF-${year}${month}${day}-${random}`;
}

// Helper function to build timeframe filter
function buildTimeframeFilter(query) {
  const { from, to, date, year, month } = query;

  if (from || to) {
    const startDate = from ? new Date(from) : new Date(0);
    const endDate = to ? new Date(to) : new Date();
    if (from && to && startDate > endDate) {
      throw new Error("Start date must be before end date");
    }
    return { createdAt: { $gte: startDate, $lte: endDate } };
  }

  if (date) {
    const dayDate = new Date(date);
    const startDate = new Date(dayDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(dayDate);
    endDate.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: startDate, $lte: endDate } };
  }

  if (year && month) {
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10) - 1;
    const startDate = new Date(yearNum, monthNum, 1);
    const endDate = new Date(yearNum, monthNum + 1, 0);
    endDate.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: startDate, $lte: endDate } };
  }

  if (year) {
    const yearNum = parseInt(year, 10);
    const startDate = new Date(yearNum, 0, 1);
    const endDate = new Date(yearNum, 11, 31);
    endDate.setHours(23, 59, 59, 999);
    return { createdAt: { $gte: startDate, $lte: endDate } };
  }

  // Default to last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return { createdAt: { $gte: thirtyDaysAgo, $lte: new Date() } };
}

function computeTotalPieces(product) {
  const piecesPerCarton = Math.max(1, Number(product?.piecesPerCarton || 1));
  return Number(product?.cartonQuantity || 0) * piecesPerCarton + Number(product?.looseQuantity || 0);
}

// A transfer is only a plan/record of intent to move stock — it must never mutate
// Product.stock. The only place inventory is actually touched is a confirmed
// reception in transferReceptions.js. This is a read-only sanity check so users
// can't create a transfer for more than what's currently on hand; it does not
// reserve or deduct anything.
async function hasEnoughStock(productId, totalPieces) {
  if (!productId || totalPieces <= 0) return true;
  const product = await Product.findById(productId).lean();
  return !!product && Number(product.stock || 0) >= totalPieces;
}

// ==================== GET ALL TRANSFERS (with filters) ====================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, destinationAgency, vehiclePlate, search } = req.query;

    const filter = {};

    try {
      const timeframeFilter = buildTimeframeFilter(req.query);
      Object.assign(filter, timeframeFilter);
    } catch (timeframeError) {
      return res.status(400).json({ error: timeframeError.message });
    }

    if (status) {
      // Allow comma-separated statuses (e.g. "pending,in_transit") so the reception
      // screen can list every transfer that hasn't been received yet in one call.
      const statuses = String(status).split(",").map((s) => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }
    if (destinationAgency) filter.destinationAgency = { $regex: destinationAgency, $options: "i" };
    if (vehiclePlate) filter["transport.vehiclePlate"] = { $regex: vehiclePlate, $options: "i" };
    if (search) {
      filter.$or = [
        { transferId: { $regex: search, $options: "i" } },
        { destinationAgency: { $regex: search, $options: "i" } },
        { "receiver.name": { $regex: search, $options: "i" } },
        { "transport.driverName": { $regex: search, $options: "i" } },
        { "transport.vehiclePlate": { $regex: search, $options: "i" } },
        { "product.name": { $regex: search, $options: "i" } },
      ];
    }

    const transfers = await Transfer.find(filter).sort({ createdAt: -1 }).lean();

    const summary = {
      total: transfers.length,
      pending: transfers.filter((t) => t.status === "pending").length,
      inTransit: transfers.filter((t) => t.status === "in_transit").length,
      delivered: transfers.filter((t) => t.status === "delivered").length,
      cancelled: transfers.filter((t) => t.status === "cancelled").length,
      totalPiecesTransferred: transfers.reduce((sum, t) => sum + (t.product?.totalPieces || 0), 0),
    };

    res.json({
      success: true,
      data: transfers,
      summary,
      count: transfers.length,
    });
  } catch (error) {
    console.error("Error fetching transfers:", error);
    res.status(500).json({ error: "Failed to fetch transfers", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== GET SINGLE TRANSFER ====================
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const transfer = await Transfer.findById(req.params.id).lean();

    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    res.json({ success: true, data: transfer });
  } catch (error) {
    console.error("Error fetching transfer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid transfer ID format" });
    }
    res.status(500).json({ error: "Failed to fetch transfer", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== CREATE TRANSFER ====================
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      product,
      sourceLocation,
      destinationAgency,
      receiver,
      transport,
      notes,
      operationDate,
    } = req.body;

    // Validate required fields
    if (!sourceLocation?.trim()) {
      return res.status(400).json({ error: "Source location is required" });
    }

    if (!product?.productId) {
      return res.status(400).json({ error: "Please select an existing inventory product for this transfer" });
    }

    if (!product?.name?.trim()) {
      return res.status(400).json({ error: "Product name is required" });
    }

    if (!product?.cartonQuantity && !product?.looseQuantity) {
      return res.status(400).json({ error: "Please specify a carton quantity or a loose quantity" });
    }

    // ---- Transfer Information validation ----
    if (!destinationAgency?.trim()) {
      return res.status(400).json({ error: "Destination agency is required" });
    }

    const hasDriverAndVehicle = transport?.driverName?.trim() && transport?.vehiclePlate?.trim();
    const hasTransportCompany = transport?.transportCompany?.trim();
    if (!hasDriverAndVehicle && !hasTransportCompany) {
      return res.status(400).json({
        error: "Provide either a driver name with vehicle plate, or a transport company",
      });
    }

    const piecesPerCarton = Math.max(1, Number(product.piecesPerCarton || 1));
    const totalPieces = computeTotalPieces(product);

    // Advisory only — creating a transfer never touches inventory itself, but we
    // still warn if the requested quantity exceeds what's currently on hand.
    if (!(await hasEnoughStock(product.productId, totalPieces))) {
      return res.status(409).json({
        error: `Insufficient stock for "${product.name}" to create this transfer.`,
      });
    }

    let customCreatedAt = null;
    if (operationDate && req.user.isAdmin) {
      const opDate = new Date(operationDate + "T12:00:00");
      if (!isNaN(opDate.getTime()) && opDate <= new Date()) customCreatedAt = opDate;
    }
    const transfer = new Transfer({
      transferId: generateTransferId(),
      product: {
        productId: product.productId,
        name: product.name.trim(),
        cartonQuantity: Number(product.cartonQuantity || 0),
        looseQuantity: Number(product.looseQuantity || 0),
        piecesPerCarton,
        totalPieces,
      },
      sourceLocation: sourceLocation.trim(),
      destinationAgency: destinationAgency.trim(),
      receiver: {
        name: receiver?.name?.trim() || "",
        phone: receiver?.phone?.trim() || "",
      },
      transport: {
        driverName: transport?.driverName?.trim() || "",
        vehiclePlate: transport?.vehiclePlate?.trim()?.toUpperCase() || "",
        transportCompany: transport?.transportCompany?.trim() || "",
        deliveryNotes: transport?.deliveryNotes?.trim() || "",
      },
      notes: notes?.trim() || "",
      status: "pending",
      createdBy: req.user.userId,
      createdByName: req.user.name || req.user.username || "Unknown",
    });
    if (customCreatedAt) transfer.createdAt = customCreatedAt;
    await transfer.save();

    res.status(201).json({
      success: true,
      message: "Transfer created successfully",
      data: transfer,
    });
  } catch (error) {
    console.error("Error creating transfer:", error.name, error.message);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (error.code === 11000) {
      return res.status(409).json({ error: "Duplicate transfer ID, please retry" });
    }
    res.status(500).json({ error: "Failed to create transfer", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== UPDATE TRANSFER STATUS ====================
router.patch("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    // "delivered" is a system-driven outcome of a confirmed reception (see
    // POST /transfer-receptions) — it is never set by hand, so that a transfer can
    // only ever be marked delivered together with the reception record and
    // inventory update that justify it.
    const validStatuses = ["pending", "in_transit", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Use one of: ${validStatuses.join(", ")}. "delivered" can only be set by confirming a reception in Transfer Reception.`,
      });
    }

    const transfer = await Transfer.findById(id);
    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    const oldStatus = transfer.status;
    const modifiedByName = req.user.name || req.user.username || "Unknown";

    // A transfer that was already received has a linked reception record which has
    // already added its stock to the destination. Changing it here would desync
    // that reception from reality, so require voiding the reception first instead
    // of silently reverting the transfer underneath it.
    if (status !== oldStatus && oldStatus === "delivered") {
      const linkedReception = await TransferReception.findOne({
        transferId: transfer._id,
        status: "active",
      }).lean();
      if (linkedReception) {
        return res.status(409).json({
          error: `This transfer was already received (reception ${linkedReception.receptionId}). Void that reception first if you need to change this transfer's status.`,
        });
      }
    }

    // Status changes here are purely a label on the transfer's lifecycle — they
    // never touch Product.stock. Only a confirmed reception in
    // transferReceptions.js adds to inventory.
    transfer.status = status;
    transfer.lastModifiedBy = req.user.userId;
    transfer.lastModifiedByName = modifiedByName;

    transfer.editHistory.push({
      modifiedBy: req.user.userId,
      modifiedByName,
      modifiedAt: new Date(),
      changes: { status: { from: oldStatus, to: status } },
      reason: reason || `Statut changé de ${oldStatus} à ${status}`,
    });

    await transfer.save();

    res.json({
      success: true,
      message: "Transfer status updated successfully",
      data: transfer,
    });
  } catch (error) {
    console.error("Error updating transfer status:", error.name, error.message);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid transfer ID format" });
    }
    res.status(500).json({ error: "Failed to update transfer status", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== CONFIRM DELIVERY & DEDUCT SOURCE INVENTORY ====================
router.patch("/:id/confirm-delivery", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid transfer ID format" });
    }

    let deliveredTransfer;
    let remainingStock;
    await session.withTransaction(async () => {
      const transfer = await Transfer.findById(id).session(session);
      if (!transfer) {
        const error = new Error("Transfer not found");
        error.status = 404;
        throw error;
      }
      if (transfer.status === "cancelled") {
        const error = new Error("A cancelled transfer cannot be confirmed as delivered");
        error.status = 409;
        throw error;
      }
      if (transfer.status === "delivered" || transfer.inventoryDeducted) {
        const error = new Error("This transfer has already been confirmed as delivered");
        error.status = 409;
        throw error;
      }
      if (!transfer.product?.productId) {
        const error = new Error("This transfer is not linked to an inventory product");
        error.status = 409;
        throw error;
      }

      const quantity = Number(transfer.product.totalPieces || 0);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        const error = new Error("The transfer quantity is invalid");
        error.status = 400;
        throw error;
      }

      // The stock predicate makes the subtraction safe even if two requests race.
      const product = await Product.findOneAndUpdate(
        { _id: transfer.product.productId, status: "active", stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { new: true, session }
      );
      if (!product) {
        const current = await Product.findById(transfer.product.productId).session(session).lean();
        const error = new Error(current
          ? `Insufficient stock for "${transfer.product.name}". Available: ${current.stock}, required: ${quantity}`
          : "The linked inventory product was not found or is inactive");
        error.status = 409;
        throw error;
      }

      const confirmedBy = req.user.name || req.user.username || "Unknown";
      const deliveredAt = new Date();
      const previousStatus = transfer.status;
      transfer.status = "delivered";
      transfer.deliveredAt = deliveredAt;
      transfer.deliveryConfirmedBy = confirmedBy;
      transfer.inventoryDeducted = true;
      transfer.lastModifiedBy = req.user.userId;
      transfer.lastModifiedByName = confirmedBy;
      transfer.editHistory.push({
        modifiedBy: req.user.userId,
        modifiedByName: confirmedBy,
        modifiedAt: deliveredAt,
        changes: { status: { from: previousStatus, to: "delivered" }, inventory: { deducted: quantity } },
        reason: reason || "Livraison confirmée et stock déduit",
      });
      await transfer.save({ session });

      await StockMovement.create([{
        productId: product._id,
        productName: product.name,
        type: "transfer_out",
        quantity,
        piecesPerCarton: transfer.product.piecesPerCarton || product.piecesPerCarton || 1,
        reference: transfer.transferId,
        notes: `Transfert livré à ${transfer.destinationAgency}${reason ? ` — ${reason}` : ""}`,
        recordedBy: confirmedBy,
        recordedByUserId: req.user.userId,
      }], { session });

      deliveredTransfer = transfer;
      remainingStock = product.stock;
    });

    res.json({
      success: true,
      message: "Delivery confirmed and inventory deducted",
      data: deliveredTransfer,
      inventory: { deducted: deliveredTransfer.product.totalPieces, remainingStock },
    });
  } catch (error) {
    console.error("Error confirming transfer delivery:", error.name, error.message);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Failed to confirm delivery",
      details: process.env.NODE_ENV !== "production" && !error.status ? error.message : undefined,
    });
  } finally {
    await session.endSession();
  }
});

// ==================== UPDATE TRANSFER (Full Edit) ====================
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      product,
      sourceLocation,
      destinationAgency,
      receiver,
      transport,
      notes,
      reason,
    } = req.body;

    const transfer = await Transfer.findById(id);
    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    if (transfer.status === "delivered" && product) {
      const linkedReception = await TransferReception.findOne({
        transferId: transfer._id,
        status: "active",
      }).lean();
      if (linkedReception) {
        return res.status(409).json({
          error: `This transfer was already received (reception ${linkedReception.receptionId}). Void that reception first if you need to change the product or quantity.`,
        });
      }
    }

    const changes = new Map();

    if (sourceLocation && sourceLocation !== transfer.sourceLocation) {
      changes.set("sourceLocation", { from: transfer.sourceLocation, to: sourceLocation });
      transfer.sourceLocation = sourceLocation;
    }

    if (destinationAgency && destinationAgency !== transfer.destinationAgency) {
      changes.set("destinationAgency", { from: transfer.destinationAgency, to: destinationAgency });
      transfer.destinationAgency = destinationAgency;
    }

    if (product) {
      const oldProductId = transfer.product.productId ? String(transfer.product.productId) : null;
      const oldTotalPieces = transfer.product.totalPieces || 0;

      const newProductId = product.productId !== undefined ? product.productId : oldProductId;
      const newCartonQuantity = product.cartonQuantity !== undefined ? Number(product.cartonQuantity) : transfer.product.cartonQuantity;
      const newLooseQuantity = product.looseQuantity !== undefined ? Number(product.looseQuantity) : transfer.product.looseQuantity;
      const newPiecesPerCarton = product.piecesPerCarton !== undefined ? Math.max(1, Number(product.piecesPerCarton)) : transfer.product.piecesPerCarton;
      const newTotalPieces = newCartonQuantity * newPiecesPerCarton + newLooseQuantity;

      const productChanged = String(newProductId || "") !== String(oldProductId || "");
      const quantityChanged = newTotalPieces !== oldTotalPieces;

      // Advisory only — editing a transfer never touches inventory itself (only a
      // confirmed reception does), but warn if the new quantity exceeds current stock.
      if ((productChanged || quantityChanged) && newProductId) {
        if (!(await hasEnoughStock(newProductId, newTotalPieces))) {
          return res.status(409).json({
            error: `Insufficient stock for "${product.name || transfer.product.name}" to apply this change.`,
          });
        }
      }

      if (product.name && product.name.trim() !== transfer.product.name) {
        changes.set("product.name", { from: transfer.product.name, to: product.name.trim() });
        transfer.product.name = product.name.trim();
      }
      if (product.productId !== undefined) transfer.product.productId = product.productId || null;
      transfer.product.cartonQuantity = newCartonQuantity;
      transfer.product.looseQuantity = newLooseQuantity;
      transfer.product.piecesPerCarton = newPiecesPerCarton;
      transfer.product.totalPieces = newTotalPieces;

      if (productChanged || quantityChanged) {
        changes.set("product.quantity", {
          from: `${oldTotalPieces} pcs`,
          to: `${newTotalPieces} pcs`,
        });
      }
    }

    if (receiver) {
      if (receiver.name !== undefined) transfer.receiver.name = receiver.name.trim();
      if (receiver.phone !== undefined) transfer.receiver.phone = receiver.phone.trim();
    }

    if (transport) {
      if (transport.driverName !== undefined) transfer.transport.driverName = transport.driverName.trim();
      if (transport.vehiclePlate !== undefined) transfer.transport.vehiclePlate = transport.vehiclePlate.trim().toUpperCase();
      if (transport.transportCompany !== undefined) transfer.transport.transportCompany = transport.transportCompany.trim();
      if (transport.deliveryNotes !== undefined) transfer.transport.deliveryNotes = transport.deliveryNotes.trim();
      changes.set("transport", { from: "updated", to: "updated" });
    }

    if (notes !== undefined && notes !== transfer.notes) {
      changes.set("notes", { from: transfer.notes, to: notes });
      transfer.notes = notes;
    }

    const modifiedByName = req.user.name || req.user.username || "Unknown";
    transfer.lastModifiedBy = req.user.userId;
    transfer.lastModifiedByName = modifiedByName;

    if (changes.size > 0) {
      transfer.editHistory.push({
        modifiedBy: req.user.userId,
        modifiedByName,
        modifiedAt: new Date(),
        changes: Object.fromEntries(changes),
        reason: reason || "Transfer information updated",
      });
    }

    await transfer.save();

    res.json({
      success: true,
      message: "Transfer updated successfully",
      data: transfer,
    });
  } catch (error) {
    console.error("Error updating transfer:", error.name, error.message);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ error: `Invalid value for field: ${error.path}` });
    }
    res.status(500).json({ error: "Failed to update transfer", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== DELETE TRANSFER ====================
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete transfers" });
    }

    const transfer = await Transfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    if (transfer.status === "delivered") {
      const linkedReception = await TransferReception.findOne({
        transferId: transfer._id,
        status: "active",
      }).lean();
      if (linkedReception) {
        return res.status(409).json({
          error: `This transfer was already received (reception ${linkedReception.receptionId}). Void that reception first — deleting the transfer would orphan its reception history.`,
        });
      }
    }

    // Deleting a transfer never touches inventory — it was never deducted when
    // created, so there's nothing to restore.
    await transfer.deleteOne();

    res.json({ success: true, message: "Transfer deleted successfully" });
  } catch (error) {
    console.error("Error deleting transfer:", error.name, error.message);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid transfer ID format" });
    }
    res.status(500).json({ error: "Failed to delete transfer", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

module.exports = router;
