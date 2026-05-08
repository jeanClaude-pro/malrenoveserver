const express = require("express");
const router = express.Router();
const Customer = require("../models/Customer");
const Sale = require("../models/Sale");

// GET /api/customers - Get all customers with optional filtering and time frame
router.get("/", async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      search,
      timeFrame,
      startDate,
      endDate,
      minSpent,
      maxSpent
    } = req.query;
    
    // Build filter object
    const filter = {};
    
    // Search filter
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } }
      ];
    }
    
    // Time frame filter
    if (timeFrame && timeFrame !== 'all') {
      const now = new Date();
      let dateFilter = {};
      
      switch(timeFrame) {
        case 'today':
          dateFilter = {
            $gte: new Date(now.setHours(0, 0, 0, 0)),
            $lte: new Date(now.setHours(23, 59, 59, 999))
          };
          break;
        case 'week':
          const weekAgo = new Date(now.setDate(now.getDate() - 7));
          dateFilter = { $gte: weekAgo };
          break;
        case 'month':
          const monthAgo = new Date(now.setMonth(now.getMonth() - 1));
          dateFilter = { $gte: monthAgo };
          break;
        case 'year':
          const yearAgo = new Date(now.setFullYear(now.getFullYear() - 1));
          dateFilter = { $gte: yearAgo };
          break;
        case 'custom':
          if (startDate && endDate) {
            dateFilter = {
              $gte: new Date(startDate),
              $lte: new Date(endDate)
            };
          }
          break;
      }
      
      filter.lastPurchaseDate = dateFilter;
    }
    
    // Spending range filter
    if (minSpent || maxSpent) {
      filter.totalSpent = {};
      if (minSpent) filter.totalSpent.$gte = parseFloat(minSpent);
      if (maxSpent) filter.totalSpent.$lte = parseFloat(maxSpent);
    }
    
    const customers = await Customer.find(filter)
      .sort({ totalSpent: -1, lastPurchaseDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Customer.countDocuments(filter);
    
    // Get summary statistics for the filtered customers
    const stats = await Customer.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          totalRevenue: { $sum: "$totalSpent" },
          averageSpent: { $avg: "$totalSpent" },
          customersWithPurchases: { 
            $sum: { $cond: [{ $gt: ["$totalPurchases", 0] }, 1, 0] } 
          }
        }
      }
    ]);
    
    res.json({
      customers,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      stats: stats[0] || {
        totalCustomers: 0,
        totalRevenue: 0,
        averageSpent: 0,
        customersWithPurchases: 0
      }
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// GET /api/customers/all - Get ALL customers without pagination (for export/overview)
router.get("/all", async (req, res) => {
  try {
    const { search, sortBy = 'totalSpent', sortOrder = 'desc' } = req.query;
    
    // Build filter
    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } }
      ];
    }
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    const customers = await Customer.find(filter)
      .sort(sort)
      .lean(); // Use lean() for better performance
    
    // Get comprehensive statistics
    const stats = await Customer.aggregate([
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          totalRevenue: { $sum: "$totalSpent" },
          averageSpent: { $avg: "$totalSpent" },
          maxSpent: { $max: "$totalSpent" },
          minSpent: { $min: "$totalSpent" },
          totalPurchases: { $sum: "$totalPurchases" },
          customersWithPurchases: { 
            $sum: { $cond: [{ $gt: ["$totalPurchases", 0] }, 1, 0] } 
          }
        }
      }
    ]);
    
    res.json({
      customers,
      total: customers.length,
      stats: stats[0] || {
        totalCustomers: 0,
        totalRevenue: 0,
        averageSpent: 0,
        maxSpent: 0,
        minSpent: 0,
        totalPurchases: 0,
        customersWithPurchases: 0
      }
    });
  } catch (error) {
    console.error("Error fetching all customers:", error);
    res.status(500).json({ error: "Failed to fetch all customers" });
  }
});

// GET /api/customers/timeframe/:period - Get customers by specific time period
router.get("/timeframe/:period", async (req, res) => {
  try {
    const { period } = req.params;
    const { page = 1, limit = 50 } = req.query;
    
    const now = new Date();
    let startDate;
    let periodName;
    
    switch(period) {
      case 'today':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        periodName = "Today";
        break;
      case 'yesterday':
        startDate = new Date(now.setDate(now.getDate() - 1));
        startDate.setHours(0, 0, 0, 0);
        periodName = "Yesterday";
        break;
      case 'this-week':
        startDate = new Date(now.setDate(now.getDate() - now.getDay()));
        startDate.setHours(0, 0, 0, 0);
        periodName = "This Week";
        break;
      case 'last-week':
        startDate = new Date(now.setDate(now.getDate() - now.getDay() - 7));
        startDate.setHours(0, 0, 0, 0);
        periodName = "Last Week";
        break;
      case 'this-month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        periodName = "This Month";
        break;
      case 'last-month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        periodName = "Last Month";
        break;
      case 'this-year':
        startDate = new Date(now.getFullYear(), 0, 1);
        periodName = "This Year";
        break;
      default:
        return res.status(400).json({ error: "Invalid time period" });
    }
    
    const filter = {
      lastPurchaseDate: { $gte: startDate }
    };
    
    const customers = await Customer.find(filter)
      .sort({ lastPurchaseDate: -1, totalSpent: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Customer.countDocuments(filter);
    
    // Get sales data for this period
    const salesData = await Sale.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          status: { $nin: ["voided", "corrected"] }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: "$total" },
          averageSale: { $avg: "$total" }
        }
      }
    ]);
    
    res.json({
      period: periodName,
      startDate,
      endDate: new Date(),
      customers,
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      salesSummary: salesData[0] || { totalSales: 0, totalRevenue: 0, averageSale: 0 }
    });
  } catch (error) {
    console.error("Error fetching customers by timeframe:", error);
    res.status(500).json({ error: "Failed to fetch customers by timeframe" });
  }
});

// GET /api/customers/:id - Get a single customer by ID
router.get("/:id", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    // Get customer's purchase history
    const purchaseHistory = await Sale.find({ 
      customerId: req.params.id,
      status: { $nin: ["voided", "corrected"] }
    }).sort({ createdAt: -1 });
    
    res.json({
      ...customer.toObject(),
      purchaseHistory
    });
  } catch (error) {
    console.error("Error fetching customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// GET /api/customers/phone/:phone - Get customer by phone number
router.get("/phone/:phone", async (req, res) => {
  try {
    const customer = await Customer.findOne({ phone: req.params.phone });
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer by phone:", error);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// POST /api/customers/:id/recalculate - Recalculate customer statistics
router.post("/:id/recalculate", async (req, res) => {
  try {
    const customerId = req.params.id;
    
    // Get all completed sales for this customer
    const sales = await Sale.find({ 
      customerId: customerId,
      status: { $nin: ["voided", "corrected"] }
    }).sort({ createdAt: 1 });
    
    if (sales.length === 0) {
      // If no valid sales, reset the customer stats
      const updatedCustomer = await Customer.findByIdAndUpdate(
        customerId,
        {
          totalPurchases: 0,
          totalSpent: 0,
          firstPurchaseDate: null,
          lastPurchaseDate: null,
        },
        { new: true }
      );
      
      return res.json(updatedCustomer);
    }
    
    // Recalculate totals from VALID sales only
    const totalPurchases = sales.length;
    const totalSpent = sales.reduce((sum, sale) => sum + sale.total, 0);
    const firstPurchaseDate = sales[0].createdAt;
    const lastPurchaseDate = sales[sales.length - 1].createdAt;

    // Update customer
    const updatedCustomer = await Customer.findByIdAndUpdate(
      customerId,
      {
        totalPurchases,
        totalSpent,
        firstPurchaseDate,
        lastPurchaseDate,
      },
      { new: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json(updatedCustomer);
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to recalculate customer statistics" });
  }
});

// PUT /api/customers/:id - Update a customer
router.put("/:id", async (req, res) => {
  try {
    const { name, email, phone, address, notes } = req.body;
    
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (notes !== undefined) updateData.notes = notes;
    
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (error) {
    console.error("Error updating customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    res.status(500).json({ error: "Failed to update customer" });
  }
});

// DELETE /api/customers/:id - Delete a customer
router.delete("/:id", async (req, res) => {
  try {
    // Check if customer has any sales
    const hasSales = await Sale.exists({ customerId: req.params.id });
    
    if (hasSales) {
      return res.status(400).json({ 
        error: "Cannot delete customer with existing sales. Consider archiving instead." 
      });
    }
    
    const customer = await Customer.findByIdAndDelete(req.params.id);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json({ message: "Customer deleted successfully", customer });
  } catch (error) {
    console.error("Error deleting customer:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    
    res.status(500).json({ error: "Failed to delete customer" });
  }
});

// GET /api/customers/stats/top - Get top customers by spending
router.get("/stats/top", async (req, res) => {
  try {
    const { limit = 10, timeFrame } = req.query;
    
    let filter = {};
    
    // Apply time frame filter if specified
    if (timeFrame && timeFrame !== 'all') {
      const now = new Date();
      let dateFilter = {};
      
      switch(timeFrame) {
        case 'today':
          dateFilter = { $gte: new Date(now.setHours(0, 0, 0, 0)) };
          break;
        case 'week':
          dateFilter = { $gte: new Date(now.setDate(now.getDate() - 7)) };
          break;
        case 'month':
          dateFilter = { $gte: new Date(now.setMonth(now.getMonth() - 1)) };
          break;
        case 'year':
          dateFilter = { $gte: new Date(now.setFullYear(now.getFullYear() - 1)) };
          break;
      }
      
      filter.lastPurchaseDate = dateFilter;
    }
    
    const topCustomers = await Customer.find(filter)
      .sort({ totalSpent: -1 })
      .limit(parseInt(limit));
    
    res.json(topCustomers);
  } catch (error) {
    console.error("Error fetching top customers:", error);
    res.status(500).json({ error: "Failed to fetch top customers" });
  }
});

module.exports = router;