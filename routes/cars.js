// routes/carTrips.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const CarTrip = require("../models/Cars");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const authMiddleware = require("../middleware/auth");
const {
  scopedFilter,
  adjustBranchStock,
} = require("../utils/branchContext");

// Helper function to generate unique trip ID
function generateTripId() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `TRIP-${year}${month}${day}-${random}`;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw httpError(400, `${fieldName} doit être un entier supérieur à zéro`);
  }
  return number;
}

function nonNegativeNumber(value, fieldName) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) {
    throw httpError(400, `${fieldName} doit être un nombre positif ou nul`);
  }
  return number;
}

function getTripProducts(trip) {
  if (Array.isArray(trip.products) && trip.products.length > 0) {
    return trip.products.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      boxesCount: Number(item.boxesCount),
      piecesPerBox: Number(item.piecesPerBox),
      totalPieces: Number(item.totalPieces || item.boxesCount * item.piecesPerBox),
      weight: Number(item.weight || 0),
      value: Number(item.value || 0),
    }));
  }

  if (!trip.cargo) return [];
  return [{
    productId: trip.cargo.productId,
    productName: trip.cargo.productName,
    boxesCount: Number(trip.cargo.boxesCount),
    piecesPerBox: Number(trip.cargo.piecesPerBox),
    totalPieces: Number(trip.cargo.totalPieces || trip.cargo.boxesCount * trip.cargo.piecesPerBox),
    weight: Number(trip.cargo.weight || 0),
    value: Number(trip.cargo.value || 0),
  }];
}

function totalTripPieces(trip) {
  return getTripProducts(trip).reduce((sum, item) => sum + item.totalPieces, 0);
}

function totalTripValue(trip) {
  return getTripProducts(trip).reduce((sum, item) => sum + item.value, 0);
}

async function buildCargoProducts(products, cargo, session, requireActive = true, branchId) {
  const requested = Array.isArray(products) ? products : cargo ? [cargo] : [];
  if (requested.length === 0) {
    throw httpError(400, "Veuillez sélectionner au moins un produit pour le chargement");
  }

  const seen = new Set();
  const normalized = requested.map((item, index) => {
    const productId = String(item?.productId || "");
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      throw httpError(400, `Produit invalide à la ligne ${index + 1}`);
    }
    if (seen.has(productId)) {
      throw httpError(400, "Un produit ne peut apparaître qu'une seule fois dans un trajet");
    }
    seen.add(productId);

    const boxesCount = positiveInteger(item.boxesCount ?? item.quantity, `La quantité à la ligne ${index + 1}`);
    const piecesPerBox = positiveInteger(item.piecesPerBox, `Les pièces par carton à la ligne ${index + 1}`);
    return {
      productId,
      boxesCount,
      piecesPerBox,
      totalPieces: boxesCount * piecesPerBox,
      weight: nonNegativeNumber(item.weight, `Le poids à la ligne ${index + 1}`),
      value: nonNegativeNumber(item.value, `La valeur à la ligne ${index + 1}`),
    };
  });

  let query = Product.find(
    scopedFilter({ _id: { $in: normalized.map((item) => item.productId) } }, branchId)
  ).lean();
  if (session) query = query.session(session);
  const databaseProducts = await query;
  const byId = new Map(databaseProducts.map((product) => [String(product._id), product]));

  return normalized.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw httpError(404, "Un produit du chargement est introuvable");
    if (requireActive && product.status !== "active") {
      throw httpError(400, `Impossible d'expédier un produit inactif: ${product.name}`);
    }
    return { ...item, productId: product._id, productName: product.name };
  });
}

function aggregateInventoryItems(items) {
  const totals = new Map();
  for (const item of items || []) {
    const productId = String(item.productId || "");
    const quantity = Number(item.quantity || 0);
    if (!productId || quantity <= 0) continue;
    const current = totals.get(productId) || {
      productId: item.productId,
      productName: item.productName,
      quantity: 0,
      piecesPerCarton: Number(item.piecesPerCarton || 1),
    };
    current.quantity += quantity;
    totals.set(productId, current);
  }
  return Array.from(totals.values());
}

async function getProcessedInventoryItems(trip, session) {
  if (trip.inventoryProcessed && Array.isArray(trip.inventoryItems) && trip.inventoryItems.length > 0) {
    return aggregateInventoryItems(trip.inventoryItems);
  }

  if (!['arrived', 'completed'].includes(trip.status)) return [];
  const movements = await StockMovement.find(scopedFilter({
    type: "car_arrival",
    reference: trip.tripId,
  }, trip.branchId || "butembo")).session(session).lean();

  return aggregateInventoryItems(movements.map((movement) => ({
    productId: movement.productId,
    productName: movement.productName,
    quantity: movement.quantity,
    piecesPerCarton: movement.piecesPerCarton,
  })));
}

async function applyInventoryDeltas(deltas, trip, req, session, reason) {
  const movements = [];
  const branchId = trip.branchId || req.branchId;
  for (const deltaItem of deltas) {
    if (!deltaItem.delta) continue;
    let product;
    if (deltaItem.delta < 0) {
      product = await adjustBranchStock({
        productId: deltaItem.productId,
        branchId,
        delta: deltaItem.delta,
        requireAvailable: true,
        session,
      });
      if (!product) {
        const current = await Product.findOne(
          scopedFilter({ _id: deltaItem.productId }, branchId)
        ).session(session).lean();
        if (!current) throw httpError(409, `Le produit "${deltaItem.productName}" n'existe plus; le stock ne peut pas être corrigé`);
        throw httpError(409, `Stock insuffisant pour corriger "${current.name}". Disponible: ${current.stock}, requis: ${Math.abs(deltaItem.delta)}`);
      }
    } else {
      product = await adjustBranchStock({ productId: deltaItem.productId, branchId, delta: deltaItem.delta, session });
      if (!product) throw httpError(409, `Le produit "${deltaItem.productName}" n'existe plus; le stock ne peut pas être corrigé`);
    }

    movements.push({
      productId: product._id,
      productName: product.name,
      type: deltaItem.delta > 0 ? "adjustment_in" : "adjustment_out",
      quantity: Math.abs(deltaItem.delta),
      piecesPerCarton: deltaItem.piecesPerCarton || product.piecesPerCarton || 1,
      reference: trip.tripId,
      notes: reason,
      recordedBy: req.user.name || req.user.username || "Unknown",
      recordedByUserId: req.user.userId,
      recordedByRole: req.user.role,
      branchId,
      previousStock: product.stock - deltaItem.delta,
      newStock: product.stock,
    });
  }
  if (movements.length > 0) await StockMovement.create(movements, { session });
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
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  if (date) {
    const dayDate = new Date(date);
    const startDate = new Date(dayDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(dayDate);
    endDate.setHours(23, 59, 59, 999);
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  if (year && month) {
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10) - 1;
    const startDate = new Date(yearNum, monthNum, 1);
    const endDate = new Date(yearNum, monthNum + 1, 0);
    endDate.setHours(23, 59, 59, 999);
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  if (year) {
    const yearNum = parseInt(year, 10);
    const startDate = new Date(yearNum, 0, 1);
    const endDate = new Date(yearNum, 11, 31);
    endDate.setHours(23, 59, 59, 999);
    return {
      createdAt: {
        $gte: startDate,
        $lte: endDate
      }
    };
  }
  
  // Default to last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return {
    createdAt: {
      $gte: thirtyDaysAgo,
      $lte: new Date()
    }
  };
}

// ==================== GET ALL CAR TRIPS (with filters) ====================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, plateNumber, driverPhone, origin, destination } = req.query;
    
    // Build filter
    const filter = {};
    
    // Add timeframe filter
    try {
      const timeframeFilter = buildTimeframeFilter(req.query);
      Object.assign(filter, timeframeFilter);
    } catch (timeframeError) {
      return res.status(400).json({ error: timeframeError.message });
    }
    
    // Add other filters
    if (status) filter.status = status;
    if (plateNumber) filter["vehicle.plateNumber"] = { $regex: plateNumber, $options: "i" };
    if (driverPhone) filter["driver.phone"] = driverPhone;
    if (origin) filter.origin = { $regex: origin, $options: "i" };
    if (destination) filter.destination = { $regex: destination, $options: "i" };
    
    const trips = await CarTrip.find(scopedFilter(filter, req.branchId))
      .sort({ departureTime: -1 })
      .lean();
    
    // Calculate summary statistics
    const summary = {
      totalTrips: trips.length,
      planned: trips.filter(t => t.status === "planned").length,
      enRoute: trips.filter(t => t.status === "en_route").length,
      arrived: trips.filter(t => t.status === "arrived").length,
      completed: trips.filter(t => t.status === "completed").length,
      cancelled: trips.filter(t => t.status === "cancelled").length,
      totalPiecesTransported: trips.reduce((sum, trip) => sum + totalTripPieces(trip), 0),
      totalValue: trips.reduce((sum, trip) => sum + totalTripValue(trip), 0),
      totalCost: trips.reduce((sum, trip) => sum + (trip.totalCost || 0), 0),
    };
    
    res.json({
      success: true,
      data: trips,
      summary,
      count: trips.length,
    });
  } catch (error) {
    console.error("Error fetching car trips:", error);
    res.status(500).json({ error: "Failed to fetch car trips", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== GET STATISTICS ====================
router.get("/stats/summary", authMiddleware, async (req, res) => {
  try {
    const { year, month } = req.query;
    
    let startDate, endDate;
    
    if (year && month) {
      const yearNum = parseInt(year, 10);
      const monthNum = parseInt(month, 10) - 1;
      startDate = new Date(yearNum, monthNum, 1);
      endDate = new Date(yearNum, monthNum + 1, 0);
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Default to current month
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
    }
    
    const trips = await CarTrip.find(scopedFilter({
      createdAt: { $gte: startDate, $lte: endDate },
    }, req.branchId));
    
    const stats = {
      period: {
        start: startDate,
        end: endDate,
      },
      totalTrips: trips.length,
      byStatus: {
        planned: trips.filter(t => t.status === "planned").length,
        en_route: trips.filter(t => t.status === "en_route").length,
        arrived: trips.filter(t => t.status === "arrived").length,
        completed: trips.filter(t => t.status === "completed").length,
        cancelled: trips.filter(t => t.status === "cancelled").length,
      },
      totalPiecesTransported: trips.reduce((sum, t) => sum + totalTripPieces(t), 0),
      totalValue: trips.reduce((sum, t) => sum + totalTripValue(t), 0),
      totalCost: trips.reduce((sum, t) => sum + (t.totalCost || 0), 0),
      averageTripCost: trips.length > 0 ? trips.reduce((sum, t) => sum + t.totalCost, 0) / trips.length : 0,
    };
    
    res.json(stats);
  } catch (error) {
    console.error("Error fetching trip statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// ==================== GET SINGLE CAR TRIP ====================
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const trip = await CarTrip.findOne(scopedFilter({ _id: req.params.id }, req.branchId)).lean();
    
    if (!trip) {
      return res.status(404).json({ error: "Car trip not found" });
    }
    
    res.json({
      success: true,
      data: trip,
    });
  } catch (error) {
    console.error("Error fetching car trip:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid trip ID format" });
    }
    res.status(500).json({ error: "Failed to fetch car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== CREATE CAR TRIP ====================
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      origin,
      destination,
      driver,
      vehicle,
      cargo,
      products,
      departureTime,
      expectedArrivalTime,
      fuelCost,
      tollCost,
      otherCosts,
      notes,
      operationDate,
    } = req.body;
    
    // Validate required fields
    if (!origin || !destination) {
      return res.status(400).json({ error: "Origin and destination are required" });
    }
    
    if (!driver?.name || !driver?.phone) {
      return res.status(400).json({ error: "Driver name and phone are required" });
    }
    
    if (!vehicle?.plateNumber) {
      return res.status(400).json({ error: "Vehicle plate number is required" });
    }

    if (!departureTime) {
      return res.status(400).json({ error: "Departure time is required" });
    }

    const cargoProducts = await buildCargoProducts(products, cargo, null, true, req.branchId);
    const firstProduct = cargoProducts[0];

    // Create trip
    const trip = new CarTrip({
      branchId: req.branchId,
      tripId: generateTripId(),
      origin,
      destination,
      driver: {
        name: driver.name,
        phone: driver.phone,
        licenseNumber: driver.licenseNumber || "",
      },
      vehicle: {
        plateNumber: vehicle.plateNumber.toUpperCase(),
        model: vehicle.model || "",
        capacity: vehicle.capacity || 0,
      },
      cargo: {
        productId: firstProduct.productId,
        productName: firstProduct.productName,
        boxesCount: firstProduct.boxesCount,
        piecesPerBox: firstProduct.piecesPerBox,
        totalPieces: firstProduct.totalPieces,
        weight: firstProduct.weight,
        value: firstProduct.value,
      },
      products: cargoProducts,
      departureTime: new Date(departureTime),
      expectedArrivalTime: expectedArrivalTime ? new Date(expectedArrivalTime) : null,
      fuelCost: fuelCost || 0,
      tollCost: tollCost || 0,
      otherCosts: otherCosts || 0,
      notes: notes || "",
      status: "en_route",
      createdBy: req.user.userId,
      createdByName: req.user.name || req.user.username || "Unknown",
    });
    
    if (operationDate && req.user.isAdmin) {
      const opDate = new Date(operationDate + "T12:00:00");
      if (!isNaN(opDate.getTime()) && opDate <= new Date()) {
        trip.createdAt = opDate;
      }
    }
    await trip.save();

    res.status(201).json({
      success: true,
      message: "Car trip created successfully",
      data: trip,
    });
  } catch (error) {
    console.error("Error creating car trip:", error.name, error.message);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ error: `Invalid value for field: ${error.path}` });
    }
    if (error.code === 11000) {
      return res.status(409).json({ error: "Duplicate trip ID, please retry" });
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to create car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== CONFIRM ARRIVAL (Car has arrived, record received qty) ====================
router.patch("/:id/confirm-arrival", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (!req.user.canValidate) {
      return res.status(403).json({ error: "Seuls les administrateurs et responsables peuvent confirmer une arrivée" });
    }
    const { id } = req.params;
    const { receivedBoxes, receivedPieces, receivedProducts, notes, actualArrivalTime } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid trip ID" });
    }

    let savedTrip;
    await session.withTransaction(async () => {
      const trip = await CarTrip.findOne(scopedFilter({ _id: id }, req.branchId)).session(session);
      if (!trip) throw httpError(404, "Trip not found");
      if (trip.inventoryProcessed || trip.status === "arrived" || trip.status === "completed") {
        throw httpError(409, "Trip arrival already confirmed");
      }
      if (trip.status === "cancelled") {
        throw httpError(400, "Cannot confirm arrival of a cancelled trip");
      }

      const plannedProducts = getTripProducts(trip);
      const isUnlinkedLegacyTrip =
        plannedProducts.length === 1 &&
        !mongoose.Types.ObjectId.isValid(String(plannedProducts[0].productId || ""));
      if (isUnlinkedLegacyTrip) {
        const legacyReceipt = Array.isArray(receivedProducts) ? receivedProducts[0] || {} : {};
        const boxes = Number(legacyReceipt.receivedBoxes ?? receivedBoxes ?? plannedProducts[0].boxesCount);
        const pieces = Number(legacyReceipt.receivedPieces ?? receivedPieces ?? plannedProducts[0].piecesPerBox);
        if (!Number.isInteger(boxes) || boxes < 0 || !Number.isInteger(pieces) || pieces < 0) {
          throw httpError(400, "Les quantités reçues doivent être des entiers positifs ou nuls");
        }
        const now = new Date();
        const arrivalDate = actualArrivalTime ? new Date(actualArrivalTime) : now;
        if (Number.isNaN(arrivalDate.getTime())) throw httpError(400, "Date d'arrivée invalide");
        const confirmedBy = req.user.name || req.user.username || "Unknown";
        const previousStatus = trip.status;
        trip.status = "arrived";
        trip.actualArrivalTime = arrivalDate;
        trip.arrivalDetails = {
          confirmedAt: now,
          confirmedBy,
          receivedBoxes: boxes,
          receivedPieces: pieces,
          totalReceivedPieces: boxes * pieces,
          notes: (notes || "").trim(),
        };
        trip.lastModifiedBy = req.user.userId;
        trip.lastModifiedByName = confirmedBy;
        trip.lastUpdate = now;
        trip.editHistory.push({
          modifiedBy: req.user.userId,
          modifiedByName: confirmedBy,
          modifiedAt: now,
          changes: { status: { from: previousStatus, to: "arrived" } },
          reason: "Arrivée confirmée pour un ancien trajet sans produit lié; inventaire inchangé",
        });
        await trip.save({ session });
        savedTrip = trip;
        return;
      }

      const receivedByProduct = new Map();
      if (Array.isArray(receivedProducts)) {
        for (const [index, received] of receivedProducts.entries()) {
          const productId = String(received?.productId || "");
          if (!mongoose.Types.ObjectId.isValid(productId) || receivedByProduct.has(productId)) {
            throw httpError(400, `Produit reçu invalide à la ligne ${index + 1}`);
          }
          const boxes = Number(received.receivedBoxes ?? received.boxesCount);
          const pieces = Number(received.receivedPieces ?? received.piecesPerBox);
          if (!Number.isInteger(boxes) || boxes < 0 || !Number.isInteger(pieces) || pieces < 0) {
            throw httpError(400, "Les quantités reçues doivent être des entiers positifs ou nuls");
          }
          receivedByProduct.set(productId, { boxes, pieces });
        }
      }

      const inventoryItems = plannedProducts.map((planned, index) => {
        const productId = String(planned.productId || "");
        if (!mongoose.Types.ObjectId.isValid(productId)) {
          throw httpError(409, `Le trajet contient un ancien produit non lié à l'inventaire: ${planned.productName}`);
        }
        let receipt = receivedByProduct.get(productId);
        if (!receipt && plannedProducts.length === 1 && !Array.isArray(receivedProducts)) {
          const boxes = Number(receivedBoxes);
          const pieces = Number(receivedPieces);
          if (!Number.isInteger(boxes) || boxes < 0 || !Number.isInteger(pieces) || pieces < 0) {
            throw httpError(400, "Les quantités reçues doivent être des entiers positifs ou nuls");
          }
          receipt = { boxes, pieces };
        }
        if (!receipt && !Array.isArray(receivedProducts)) {
          receipt = { boxes: planned.boxesCount, pieces: planned.piecesPerBox };
        }
        if (!receipt) throw httpError(400, `Quantité reçue manquante à la ligne ${index + 1}`);
        return {
          productId: planned.productId,
          productName: planned.productName,
          quantity: receipt.boxes * receipt.pieces,
          piecesPerCarton: receipt.pieces || planned.piecesPerBox || 1,
          receivedBoxes: receipt.boxes,
          receivedPieces: receipt.pieces,
        };
      });

      if (receivedByProduct.size > plannedProducts.length) {
        throw httpError(400, "La réception contient un produit qui n'appartient pas au trajet");
      }

      const productIds = plannedProducts.map((item) => item.productId);
      const inventoryProducts = await Product.find(
        scopedFilter({ _id: { $in: productIds } }, req.branchId)
      ).session(session);
      const inventoryById = new Map(inventoryProducts.map((product) => [String(product._id), product]));
      if (inventoryProducts.length !== productIds.length) {
        throw httpError(409, "Un produit du trajet n'existe plus; l'arrivée ne peut pas être synchronisée avec le stock");
      }

      const now = new Date();
      const arrivalDate = actualArrivalTime ? new Date(actualArrivalTime) : now;
      if (Number.isNaN(arrivalDate.getTime())) throw httpError(400, "Date d'arrivée invalide");
      const confirmedBy = req.user.name || req.user.username || "Unknown";
      const totalReceived = inventoryItems.reduce((sum, item) => sum + item.quantity, 0);
      const positiveItems = inventoryItems.filter((item) => item.quantity > 0);

      const previousStocks = new Map(inventoryProducts.map((product) => [String(product._id), product.stock]));
      for (const item of positiveItems) {
        await adjustBranchStock({ productId: item.productId, branchId: req.branchId, delta: item.quantity, session });
      }
      if (positiveItems.length > 0) {
        await StockMovement.create(positiveItems.map((item) => ({
          productId: item.productId,
          productName: inventoryById.get(String(item.productId)).name,
          type: "car_arrival",
          quantity: item.quantity,
          piecesPerCarton: item.piecesPerCarton,
          reference: trip.tripId,
          notes: (notes || "").trim(),
          recordedBy: confirmedBy,
          recordedByUserId: req.user.userId,
          recordedByRole: req.user.role,
          branchId: req.branchId,
          previousStock: previousStocks.get(String(item.productId)) || 0,
          newStock: (previousStocks.get(String(item.productId)) || 0) + item.quantity,
        })), { session });
      }

      const previousStatus = trip.status;
      trip.status = "arrived";
      trip.actualArrivalTime = arrivalDate;
      trip.arrivalDetails = {
        confirmedAt: now,
        confirmedBy,
        receivedBoxes: inventoryItems.reduce((sum, item) => sum + item.receivedBoxes, 0),
        receivedPieces: inventoryItems.length === 1 ? inventoryItems[0].receivedPieces : 0,
        totalReceivedPieces: totalReceived,
        products: positiveItems.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          piecesPerCarton: item.piecesPerCarton,
        })),
        notes: (notes || "").trim(),
      };
      trip.inventoryProcessed = true;
      trip.inventoryProcessedAt = now;
      trip.inventoryItems = positiveItems.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        piecesPerCarton: item.piecesPerCarton,
      }));
      trip.lastModifiedBy = req.user.userId;
      trip.lastModifiedByName = confirmedBy;
      trip.lastUpdate = now;
      trip.editHistory.push({
        modifiedBy: req.user.userId,
        modifiedByName: confirmedBy,
        modifiedAt: now,
        changes: { status: { from: previousStatus, to: "arrived" }, inventoryItems: trip.inventoryItems },
        reason: `Arrivée confirmée — ${positiveItems.length} produit(s), ${totalReceived} pcs reçues`,
      });
      await trip.save({ session });
      savedTrip = trip;
    });

    res.json({
      success: true,
      message: "Arrivée confirmée avec succès",
      data: savedTrip,
    });
  } catch (error) {
    console.error("Error confirming arrival:", error.message);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to confirm arrival", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  } finally {
    await session.endSession();
  }
});

// ==================== UPDATE CAR TRIP STATUS ====================
router.patch("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason, currentLocation } = req.body;
    
    const validStatuses = ["planned", "en_route", "delayed", "arrived", "cancelled", "completed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    
    const trip = await CarTrip.findOne(scopedFilter({ _id: id }, req.branchId));
    if (!trip) {
      return res.status(404).json({ error: "Car trip not found" });
    }

    if (
      ["arrived", "completed"].includes(status) &&
      !["arrived", "completed"].includes(trip.status) &&
      !trip.inventoryProcessed
    ) {
      return res.status(400).json({
        error: "Confirmez l'arrivée avec l'action dédiée afin de synchroniser tous les produits avec l'inventaire",
      });
    }
    
    const oldStatus = trip.status;
    const changes = new Map();
    changes.set("status", { from: oldStatus, to: status });
    if (currentLocation) changes.set("currentLocation", { from: trip.currentLocation, to: currentLocation });
    
    // Update actual arrival time if status is arrived or completed
    let actualArrivalTime = trip.actualArrivalTime;
    if (status === "arrived" || status === "completed") {
      actualArrivalTime = new Date();
      changes.set("actualArrivalTime", { from: trip.actualArrivalTime, to: actualArrivalTime });
    }
    
    trip.status = status;
    trip.currentLocation = currentLocation || trip.currentLocation;
    trip.actualArrivalTime = actualArrivalTime;
    trip.lastUpdate = new Date();
    trip.lastModifiedBy = req.user.userId;
    trip.lastModifiedByName = req.user.name || req.user.username || "Unknown";
    
    // Add to edit history
    trip.editHistory.push({
      modifiedBy: req.user.userId,
      modifiedByName: req.user.name || req.user.username || "Unknown",
      modifiedAt: new Date(),
      changes: Object.fromEntries(changes),
      reason: reason || `Status changed from ${oldStatus} to ${status}`,
    });
    
    await trip.save();
    
    res.json({
      success: true,
      message: "Trip status updated successfully",
      data: trip,
    });
  } catch (error) {
    console.error("Error updating trip status:", error.name, error.message);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid trip ID format" });
    }
    res.status(500).json({ error: "Failed to update trip status", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== UPDATE CAR TRIP (Full Edit) ====================
router.put("/:id", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const {
      origin,
      destination,
      driver,
      vehicle,
      cargo,
      products,
      departureTime,
      expectedArrivalTime,
      fuelCost,
      tollCost,
      otherCosts,
      notes,
      reason,
    } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(400, "Invalid trip ID format");

    let savedTrip;
    await session.withTransaction(async () => {
      const trip = await CarTrip.findOne(scopedFilter({ _id: id }, req.branchId)).session(session);
      if (!trip) throw httpError(404, "Car trip not found");
      const changes = new Map();

      if (origin && origin !== trip.origin) {
        changes.set("origin", { from: trip.origin, to: origin });
        trip.origin = origin;
      }
      if (destination && destination !== trip.destination) {
        changes.set("destination", { from: trip.destination, to: destination });
        trip.destination = destination;
      }
      if (driver) {
        if (driver.name && driver.name !== trip.driver.name) {
          changes.set("driver.name", { from: trip.driver.name, to: driver.name });
          trip.driver.name = driver.name;
        }
        if (driver.phone && driver.phone !== trip.driver.phone) {
          changes.set("driver.phone", { from: trip.driver.phone, to: driver.phone });
          trip.driver.phone = driver.phone;
        }
        if (driver.licenseNumber !== undefined) trip.driver.licenseNumber = driver.licenseNumber;
      }
      if (vehicle) {
        if (vehicle.plateNumber && vehicle.plateNumber.toUpperCase() !== trip.vehicle.plateNumber) {
          changes.set("vehicle.plateNumber", { from: trip.vehicle.plateNumber, to: vehicle.plateNumber.toUpperCase() });
          trip.vehicle.plateNumber = vehicle.plateNumber.toUpperCase();
        }
        if (vehicle.model !== undefined) trip.vehicle.model = vehicle.model;
        if (vehicle.capacity !== undefined) trip.vehicle.capacity = vehicle.capacity;
      }

      if (Array.isArray(products) || cargo) {
        const oldProducts = getTripProducts(trip);
        const cargoProducts = await buildCargoProducts(products, cargo, session, false, req.branchId);
        const inventoryShape = (items) => items.map((item) => ({
          productId: String(item.productId),
          totalPieces: Number(item.totalPieces),
        }));
        const inventoryProductsChanged = JSON.stringify(inventoryShape(oldProducts)) !== JSON.stringify(inventoryShape(cargoProducts));
        const productsChanged = JSON.stringify(oldProducts.map((item) => ({
          ...inventoryShape([item])[0],
          weight: Number(item.weight || 0),
          value: Number(item.value || 0),
        }))) !== JSON.stringify(cargoProducts.map((item) => ({
          ...inventoryShape([item])[0],
          weight: Number(item.weight || 0),
          value: Number(item.value || 0),
        })));
        const oldInventoryItems = inventoryProductsChanged
          ? await getProcessedInventoryItems(trip, session)
          : [];

        if (inventoryProductsChanged && (oldInventoryItems.length > 0 || trip.inventoryProcessed)) {
          const newInventoryItems = cargoProducts.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.totalPieces,
            piecesPerCarton: item.piecesPerBox,
          }));
          const oldById = new Map(aggregateInventoryItems(oldInventoryItems).map((item) => [String(item.productId), item]));
          const newById = new Map(aggregateInventoryItems(newInventoryItems).map((item) => [String(item.productId), item]));
          const productIds = new Set([...oldById.keys(), ...newById.keys()]);
          const deltas = Array.from(productIds).map((productId) => {
            const oldItem = oldById.get(productId);
            const newItem = newById.get(productId);
            return {
              productId: newItem?.productId || oldItem.productId,
              productName: newItem?.productName || oldItem.productName,
              piecesPerCarton: newItem?.piecesPerCarton || oldItem.piecesPerCarton,
              delta: Number(newItem?.quantity || 0) - Number(oldItem?.quantity || 0),
            };
          });
          await applyInventoryDeltas(deltas, trip, req, session, `Correction après modification du trajet: ${reason || "non précisée"}`);
          trip.inventoryProcessed = true;
          trip.inventoryProcessedAt = trip.inventoryProcessedAt || trip.arrivalDetails?.confirmedAt || new Date();
          trip.inventoryItems = newInventoryItems;
          if (trip.arrivalDetails) {
            trip.arrivalDetails.products = newInventoryItems;
            trip.arrivalDetails.totalReceivedPieces = newInventoryItems.reduce((sum, item) => sum + item.quantity, 0);
          }
        }

        if (productsChanged) changes.set("products", { from: oldProducts, to: cargoProducts });
        trip.products = cargoProducts;
        const first = cargoProducts[0];
        trip.cargo = {
          productId: first.productId,
          productName: first.productName,
          boxesCount: first.boxesCount,
          piecesPerBox: first.piecesPerBox,
          totalPieces: first.totalPieces,
          weight: first.weight,
          value: first.value,
        };
      }

      if (departureTime) {
        const date = new Date(departureTime);
        if (Number.isNaN(date.getTime())) throw httpError(400, "Invalid departure time");
        if (date.getTime() !== trip.departureTime.getTime()) {
          changes.set("departureTime", { from: trip.departureTime, to: date });
          trip.departureTime = date;
        }
      }
      if (expectedArrivalTime !== undefined) {
        const date = expectedArrivalTime ? new Date(expectedArrivalTime) : null;
        if (date && Number.isNaN(date.getTime())) throw httpError(400, "Invalid expected arrival time");
        if ((date?.getTime() || null) !== (trip.expectedArrivalTime?.getTime() || null)) {
          changes.set("expectedArrivalTime", { from: trip.expectedArrivalTime, to: date });
          trip.expectedArrivalTime = date;
        }
      }
      for (const [field, value] of [["fuelCost", fuelCost], ["tollCost", tollCost], ["otherCosts", otherCosts]]) {
        if (value !== undefined && value !== trip[field]) {
          changes.set(field, { from: trip[field], to: value });
          trip[field] = value;
        }
      }
      if (notes !== undefined && notes !== trip.notes) {
        changes.set("notes", { from: trip.notes, to: notes });
        trip.notes = notes;
      }

      trip.lastModifiedBy = req.user.userId;
      trip.lastModifiedByName = req.user.name || req.user.username || "Unknown";
      trip.lastUpdate = new Date();
      if (changes.size > 0) {
        trip.editHistory.push({
          modifiedBy: req.user.userId,
          modifiedByName: req.user.name || req.user.username || "Unknown",
          modifiedAt: new Date(),
          changes: Object.fromEntries(changes),
          reason: reason || "Trip information updated",
        });
      }
      await trip.save({ session });
      savedTrip = trip;
    });
    
    res.json({
      success: true,
      message: "Car trip updated successfully",
      data: savedTrip,
    });
  } catch (error) {
    console.error("Error updating car trip:", error.name, error.message);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ error: `Invalid value for field: ${error.path}` });
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  } finally {
    await session.endSession();
  }
});

// ==================== DELETE CAR TRIP ====================
router.delete("/:id", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    // Only admin can delete trips
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ error: "Only admins can delete car trips" });
    }
    
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid trip ID format" });
    }

    let reversedQuantity = 0;
    await session.withTransaction(async () => {
      // Load the complete trip first; its products are required for a safe reversal.
      const trip = await CarTrip.findOne(scopedFilter({ _id: req.params.id }, req.branchId)).session(session);
      if (!trip) throw httpError(404, "Car trip not found");

      const processedItems = await getProcessedInventoryItems(trip, session);
      if (processedItems.length > 0) {
        await applyInventoryDeltas(processedItems.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          piecesPerCarton: item.piecesPerCarton,
          delta: -item.quantity,
        })), trip, req, session, "Annulation automatique du stock après suppression d'un trajet arrivé");
        reversedQuantity = processedItems.reduce((sum, item) => sum + item.quantity, 0);
      }

      await CarTrip.deleteOne({ _id: trip._id }).session(session);
    });
    
    res.json({
      success: true,
      message: "Car trip deleted successfully",
      inventoryReversed: reversedQuantity,
    });
  } catch (error) {
    console.error("Error deleting car trip:", error.name, error.message);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid trip ID format" });
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to delete car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
