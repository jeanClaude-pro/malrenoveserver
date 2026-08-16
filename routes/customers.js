const express = require("express");
const router = express.Router();
const Customer = require("../models/Customer");
const Sale = require("../models/Sale");
const authMiddleware = require("../middleware/auth");
const { scopedFilter } = require("../utils/branchContext");

function customerScope(branchId) {
  return branchId === "butembo"
    ? { $or: [{ branches: "butembo" }, { branches: { $exists: false } }, { branches: null }] }
    : { branches: branchId };
}

function customerFilter(filter, branchId) {
  return { $and: [filter || {}, customerScope(branchId)] };
}

function customerForBranch(customer, branchId) {
  if (!customer) return customer;
  const value = typeof customer.toObject === "function" ? customer.toObject() : { ...customer };
  const stats = value.branchStats instanceof Map
    ? value.branchStats.get(branchId)
    : value.branchStats?.[branchId];
  if (stats) {
    value.totalPurchases = Number(stats.totalPurchases || 0);
    value.totalSpent = Number(stats.totalSpent || 0);
    value.firstPurchaseDate = stats.firstPurchaseDate || null;
    value.lastPurchaseDate = stats.lastPurchaseDate || null;
  } else if (branchId !== "butembo") {
    value.totalPurchases = 0;
    value.totalSpent = 0;
    value.firstPurchaseDate = null;
    value.lastPurchaseDate = null;
  }
  delete value.branchStats;
  delete value.branches;
  return value;
}

// All customer routes require authentication
router.use(authMiddleware);

// GET /api/customers/recent?limit=5 — last N customers by purchase date (lightweight, for dashboard)
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const customers = await Customer.find(customerFilter({}, req.branchId)).lean();
    res.json(customers.map((customer) => customerForBranch(customer, req.branchId)).filter((customer) => customer.lastPurchaseDate).sort((a, b) => new Date(b.lastPurchaseDate) - new Date(a.lastPurchaseDate)).slice(0, limit));
  } catch (error) {
    console.error("Error fetching recent customers:", error);
    res.status(500).json({ error: "Failed to fetch recent customers" });
  }
});

// GET /api/customers/fiche?phone=xxx — full fiche: customer + all their sales
router.get("/fiche", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const customer = await Customer.findOne(customerFilter({ phone: phone.trim() }, req.branchId)).lean();
    if (!customer) {
      return res.status(404).json({ error: "No customer found with that phone number" });
    }

    // Fetch all sales linked to this customer (by customerId or phone fallback)
    const sales = await Sale.find(scopedFilter({
      $or: [
        { customerId: customer._id },
        { "customer.phone": phone.trim() },
      ],
      status: { $nin: ["voided", "corrected"] },
    }, req.branchId))
      .sort({ createdAt: -1 })
      .lean();

    // Aggregate credit summary
    const creditSales = sales.filter((s) => s.paymentType === "credit");
    const totalCreditTaken = creditSales.reduce((sum, s) => sum + (s.total || 0), 0);
    const totalCreditPaid = creditSales.reduce(
      (sum, s) => sum + (s.creditDetails?.amountPaid || 0),
      0
    );
    const totalCreditDue = creditSales.reduce(
      (sum, s) => sum + (s.creditDetails?.amountDue || 0),
      0
    );
    const unpaidCredits = creditSales.filter((s) => !s.creditDetails?.fullyPaid);

    res.json({
      customer: customerForBranch(customer, req.branchId),
      sales,
      summary: {
        totalSales: sales.length,
        totalSpent: sales.reduce((sum, s) => sum + (s.total || 0), 0),
        totalCreditSales: creditSales.length,
        totalCreditTaken,
        totalCreditPaid,
        totalCreditDue,
        unpaidCreditsCount: unpaidCredits.length,
      },
    });
  } catch (error) {
    console.error("Error fetching customer fiche:", error);
    res.status(500).json({ error: "Failed to fetch customer fiche" });
  }
});

// GET /api/customers/stats/top — top customers by spending
router.get("/stats/top", async (req, res) => {
  try {
    const { limit = 10, timeFrame } = req.query;

    let filter = {};
    let dateFilter = null;

    if (timeFrame && timeFrame !== "all") {
      const now = new Date();
      dateFilter = {};

      switch (timeFrame) {
        case "today":
          dateFilter = { $gte: new Date(now.setHours(0, 0, 0, 0)) };
          break;
        case "week":
          dateFilter = { $gte: new Date(now.setDate(now.getDate() - 7)) };
          break;
        case "month":
          dateFilter = { $gte: new Date(now.setMonth(now.getMonth() - 1)) };
          break;
        case "year":
          dateFilter = { $gte: new Date(now.setFullYear(now.getFullYear() - 1)) };
          break;
      }

    }

    const topCustomers = (await Customer.find(customerFilter(filter, req.branchId)).lean())
      .map((customer) => customerForBranch(customer, req.branchId))
      .filter((customer) => {
        if (!dateFilter) return true;
        const purchaseDate = customer.lastPurchaseDate ? new Date(customer.lastPurchaseDate) : null;
        if (!purchaseDate || Number.isNaN(purchaseDate.getTime())) return false;
        return (!dateFilter.$gte || purchaseDate >= dateFilter.$gte) &&
          (!dateFilter.$lte || purchaseDate <= dateFilter.$lte);
      })
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, parseInt(limit));

    res.json(topCustomers);
  } catch (error) {
    console.error("Error fetching top customers:", error);
    res.status(500).json({ error: "Failed to fetch top customers" });
  }
});

// GET /api/customers — paginated list with filtering
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
      maxSpent,
    } = req.query;

    const filter = {};
    let dateFilter = null;

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    if (timeFrame && timeFrame !== "all") {
      const now = new Date();
      dateFilter = {};

      switch (timeFrame) {
        case "today":
          dateFilter = {
            $gte: new Date(now.setHours(0, 0, 0, 0)),
            $lte: new Date(now.setHours(23, 59, 59, 999)),
          };
          break;
        case "week":
          dateFilter = { $gte: new Date(now.setDate(now.getDate() - 7)) };
          break;
        case "month":
          dateFilter = { $gte: new Date(now.setMonth(now.getMonth() - 1)) };
          break;
        case "year":
          dateFilter = { $gte: new Date(now.setFullYear(now.getFullYear() - 1)) };
          break;
        case "custom":
          if (startDate && endDate) {
            dateFilter = {
              $gte: new Date(startDate),
              $lte: new Date(endDate),
            };
          }
          break;
      }

    }

    const minimumSpent = minSpent !== undefined && minSpent !== "" ? Number(minSpent) : null;
    const maximumSpent = maxSpent !== undefined && maxSpent !== "" ? Number(maxSpent) : null;

    const normalized = (await Customer.find(customerFilter(filter, req.branchId)).lean())
      .map((customer) => customerForBranch(customer, req.branchId))
      .filter((customer) => {
        const totalSpent = Number(customer.totalSpent || 0);
        if (minimumSpent !== null && Number.isFinite(minimumSpent) && totalSpent < minimumSpent) return false;
        if (maximumSpent !== null && Number.isFinite(maximumSpent) && totalSpent > maximumSpent) return false;
        if (!dateFilter) return true;
        const purchaseDate = customer.lastPurchaseDate ? new Date(customer.lastPurchaseDate) : null;
        if (!purchaseDate || Number.isNaN(purchaseDate.getTime())) return false;
        return (!dateFilter.$gte || purchaseDate >= dateFilter.$gte) &&
          (!dateFilter.$lte || purchaseDate <= dateFilter.$lte);
      })
      .sort((a, b) => new Date(b.lastPurchaseDate || 0) - new Date(a.lastPurchaseDate || 0));
    const total = normalized.length;
    const customers = normalized.slice((Number(page) - 1) * Number(limit), Number(page) * Number(limit));
    const totalRevenue = normalized.reduce((sum, customer) => sum + Number(customer.totalSpent || 0), 0);
    const stats = { totalCustomers: total, totalRevenue, averageSpent: total ? totalRevenue / total : 0 };

    res.json({
      customers,
      totalPages: Math.ceil(total / limit),
      currentPage: Number(page),
      total,
      stats,
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// GET /api/customers/all — full list without pagination (used by CompanyReport, exports)
router.get("/all", async (req, res) => {
  try {
    const { search, sortBy = "totalSpent", sortOrder = "desc" } = req.query;

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === "desc" ? -1 : 1;

    const customers = (await Customer.find(customerFilter(filter, req.branchId)).lean())
      .map((customer) => customerForBranch(customer, req.branchId))
      .sort((a, b) => {
        const direction = sortOrder === "desc" ? -1 : 1;
        return (Number(a[sortBy] || 0) - Number(b[sortBy] || 0)) * direction;
      });
    const totalRevenue = customers.reduce((sum, customer) => sum + Number(customer.totalSpent || 0), 0);
    const totalPurchases = customers.reduce((sum, customer) => sum + Number(customer.totalPurchases || 0), 0);
    const stats = { totalCustomers: customers.length, totalRevenue, averageSpent: customers.length ? totalRevenue / customers.length : 0, totalPurchases };

    res.json({
      customers,
      total: customers.length,
      stats,
    });
  } catch (error) {
    console.error("Error fetching all customers:", error);
    res.status(500).json({ error: "Failed to fetch all customers" });
  }
});

// GET /api/customers/phone/:phone — lookup by phone (used in NewSale auto-fill)
router.get("/phone/:phone", async (req, res) => {
  try {
    const customer = await Customer.findOne(customerFilter({ phone: req.params.phone }, req.branchId)).lean();
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    res.json(customerForBranch(customer, req.branchId));
  } catch (error) {
    console.error("Error fetching customer by phone:", error);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// GET /api/customers/:id — single customer with purchase history
router.get("/:id", async (req, res) => {
  try {
    const [customer, purchaseHistory] = await Promise.all([
      Customer.findOne(customerFilter({ _id: req.params.id }, req.branchId)).lean(),
      Sale.find(scopedFilter({
        customerId: req.params.id,
        status: { $nin: ["voided", "corrected"] },
      }, req.branchId))
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json({ ...customerForBranch(customer, req.branchId), purchaseHistory });
  } catch (error) {
    console.error("Error fetching customer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// PUT /api/customers/:id — update customer info
router.put("/:id", async (req, res) => {
  try {
    const { name, email, phone, address, notes } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (notes !== undefined) updateData.notes = notes;

    const customer = await Customer.findOneAndUpdate(
      customerFilter({ _id: req.params.id }, req.branchId),
      updateData,
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json(customerForBranch(customer, req.branchId));
  } catch (error) {
    console.error("Error updating customer:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    res.status(500).json({ error: "Failed to update customer" });
  }
});

// DELETE /api/customers/:id — only if no sales exist
router.delete("/:id", async (req, res) => {
  try {
    const hasSales = await Sale.exists({ customerId: req.params.id });
    if (hasSales) {
      return res.status(400).json({
        error: "Cannot delete customer with existing sales.",
      });
    }

    const customer = await Customer.findOneAndDelete(customerFilter({ _id: req.params.id }, req.branchId));
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

module.exports = router;
