// routes/carTrips.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const CarTrip = require("../models/Cars");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");

// Helper function to generate unique trip ID
function generateTripId() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `TRIP-${year}${month}${day}-${random}`;
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
    
    const trips = await CarTrip.find(filter)
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
      totalPiecesTransported: trips.reduce((sum, trip) => sum + (trip.cargo?.totalPieces || 0), 0),
      totalValue: trips.reduce((sum, trip) => sum + (trip.cargo?.value || 0), 0),
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
    
    const trips = await CarTrip.find({
      createdAt: { $gte: startDate, $lte: endDate },
    });
    
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
      totalPiecesTransported: trips.reduce((sum, t) => sum + (t.cargo?.totalPieces || 0), 0),
      totalValue: trips.reduce((sum, t) => sum + (t.cargo?.value || 0), 0),
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
    const trip = await CarTrip.findById(req.params.id).lean();
    
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
      departureTime,
      expectedArrivalTime,
      fuelCost,
      tollCost,
      otherCosts,
      notes,
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
    
    if (!cargo?.productId || !cargo?.boxesCount || !cargo?.piecesPerBox) {
      return res.status(400).json({ error: "Cargo product, boxes count, and pieces per box are required" });
    }
    
    if (!departureTime || !expectedArrivalTime) {
      return res.status(400).json({ error: "Departure time and expected arrival time are required" });
    }
    
    // Verify product exists
    const product = await Product.findById(cargo.productId);
    if (!product) {
      return res.status(400).json({ error: "Product not found" });
    }
    
    // Calculate total pieces
    const totalPieces = cargo.boxesCount * cargo.piecesPerBox;
    
    // Create trip
    const trip = new CarTrip({
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
        productId: cargo.productId,
        productName: product.name,
        boxesCount: cargo.boxesCount,
        piecesPerBox: cargo.piecesPerBox,
        totalPieces: totalPieces,
        weight: cargo.weight || 0,
        value: cargo.value || 0,
      },
      departureTime: new Date(departureTime),
      expectedArrivalTime: new Date(expectedArrivalTime),
      fuelCost: fuelCost || 0,
      tollCost: tollCost || 0,
      otherCosts: otherCosts || 0,
      notes: notes || "",
      status: "planned",
      createdBy: req.user.userId,
      createdByName: req.user.name || req.user.username || "Unknown",
    });
    
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
    res.status(500).json({ error: "Failed to create car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
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
    
    const trip = await CarTrip.findById(id);
    if (!trip) {
      return res.status(404).json({ error: "Car trip not found" });
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
  try {
    const { id } = req.params;
    const {
      origin,
      destination,
      driver,
      vehicle,
      cargo,
      departureTime,
      expectedArrivalTime,
      fuelCost,
      tollCost,
      otherCosts,
      notes,
      reason,
    } = req.body;
    
    // Find existing trip
    const trip = await CarTrip.findById(id);
    if (!trip) {
      return res.status(404).json({ error: "Car trip not found" });
    }
    
    // Track changes
    const changes = new Map();
    
    // Update origin
    if (origin && origin !== trip.origin) {
      changes.set("origin", { from: trip.origin, to: origin });
      trip.origin = origin;
    }
    
    // Update destination
    if (destination && destination !== trip.destination) {
      changes.set("destination", { from: trip.destination, to: destination });
      trip.destination = destination;
    }
    
    // Update driver info
    if (driver) {
      if (driver.name && driver.name !== trip.driver.name) {
        changes.set("driver.name", { from: trip.driver.name, to: driver.name });
        trip.driver.name = driver.name;
      }
      if (driver.phone && driver.phone !== trip.driver.phone) {
        changes.set("driver.phone", { from: trip.driver.phone, to: driver.phone });
        trip.driver.phone = driver.phone;
      }
      if (driver.licenseNumber !== undefined) {
        trip.driver.licenseNumber = driver.licenseNumber;
      }
    }
    
    // Update vehicle info
    if (vehicle) {
      if (vehicle.plateNumber && vehicle.plateNumber.toUpperCase() !== trip.vehicle.plateNumber) {
        changes.set("vehicle.plateNumber", { from: trip.vehicle.plateNumber, to: vehicle.plateNumber.toUpperCase() });
        trip.vehicle.plateNumber = vehicle.plateNumber.toUpperCase();
      }
      if (vehicle.model !== undefined) trip.vehicle.model = vehicle.model;
      if (vehicle.capacity !== undefined) trip.vehicle.capacity = vehicle.capacity;
    }
    
    // Update cargo info
    if (cargo) {
      if (cargo.productId && cargo.productId !== trip.cargo.productId?.toString()) {
        const product = await Product.findById(cargo.productId);
        if (product) {
          changes.set("cargo.productName", { from: trip.cargo.productName, to: product.name });
          trip.cargo.productId = cargo.productId;
          trip.cargo.productName = product.name;
        }
      }
      if (cargo.boxesCount && cargo.boxesCount !== trip.cargo.boxesCount) {
        changes.set("cargo.boxesCount", { from: trip.cargo.boxesCount, to: cargo.boxesCount });
        trip.cargo.boxesCount = cargo.boxesCount;
      }
      if (cargo.piecesPerBox && cargo.piecesPerBox !== trip.cargo.piecesPerBox) {
        changes.set("cargo.piecesPerBox", { from: trip.cargo.piecesPerBox, to: cargo.piecesPerBox });
        trip.cargo.piecesPerBox = cargo.piecesPerBox;
      }
      if (cargo.weight !== undefined) trip.cargo.weight = cargo.weight;
      if (cargo.value !== undefined) trip.cargo.value = cargo.value;
      
      // Recalculate total pieces
      trip.cargo.totalPieces = trip.cargo.boxesCount * trip.cargo.piecesPerBox;
    }
    
    // Update times
    if (departureTime && new Date(departureTime).getTime() !== trip.departureTime.getTime()) {
      changes.set("departureTime", { from: trip.departureTime, to: new Date(departureTime) });
      trip.departureTime = new Date(departureTime);
    }
    if (expectedArrivalTime && new Date(expectedArrivalTime).getTime() !== trip.expectedArrivalTime.getTime()) {
      changes.set("expectedArrivalTime", { from: trip.expectedArrivalTime, to: new Date(expectedArrivalTime) });
      trip.expectedArrivalTime = new Date(expectedArrivalTime);
    }
    
    // Update costs
    if (fuelCost !== undefined && fuelCost !== trip.fuelCost) {
      changes.set("fuelCost", { from: trip.fuelCost, to: fuelCost });
      trip.fuelCost = fuelCost;
    }
    if (tollCost !== undefined && tollCost !== trip.tollCost) {
      changes.set("tollCost", { from: trip.tollCost, to: tollCost });
      trip.tollCost = tollCost;
    }
    if (otherCosts !== undefined && otherCosts !== trip.otherCosts) {
      changes.set("otherCosts", { from: trip.otherCosts, to: otherCosts });
      trip.otherCosts = otherCosts;
    }
    
    // Update notes
    if (notes !== undefined && notes !== trip.notes) {
      changes.set("notes", { from: trip.notes, to: notes });
      trip.notes = notes;
    }
    
    // Update audit fields
    trip.lastModifiedBy = req.user.userId;
    trip.lastModifiedByName = req.user.name || req.user.username || "Unknown";
    trip.lastUpdate = new Date();
    
    // Add to edit history if there are changes
    if (changes.size > 0) {
      trip.editHistory.push({
        modifiedBy: req.user.userId,
        modifiedByName: req.user.name || req.user.username || "Unknown",
        modifiedAt: new Date(),
        changes: Object.fromEntries(changes),
        reason: reason || "Trip information updated",
      });
    }
    
    await trip.save();
    
    res.json({
      success: true,
      message: "Car trip updated successfully",
      data: trip,
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
    res.status(500).json({ error: "Failed to update car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

// ==================== DELETE CAR TRIP ====================
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    // Only admin can delete trips
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete car trips" });
    }
    
    const trip = await CarTrip.findByIdAndDelete(req.params.id);
    
    if (!trip) {
      return res.status(404).json({ error: "Car trip not found" });
    }
    
    res.json({
      success: true,
      message: "Car trip deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting car trip:", error.name, error.message);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid trip ID format" });
    }
    res.status(500).json({ error: "Failed to delete car trip", details: process.env.NODE_ENV !== "production" ? error.message : undefined });
  }
});

module.exports = router;
