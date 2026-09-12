// routes/sales.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const ExchangeRate = require("../models/ExchangeRate");
const StockMovement = require("../models/StockMovement");
const authMiddleware = require("../middleware/auth");
const { parsePagination, paginationMeta, aggregatePage } = require("../utils/pagination");
const {
  DEBT_TOLERANCE,
  calendarDateInAccountingZone,
  confirmedAmount,
  normalizeCreditSaleDocument,
  parsePaymentDate,
} = require("../utils/creditAccounting");
const {
  branchScope,
  scopedFilter,
  adjustBranchStock,
} = require("../utils/branchContext");
const { getGmt2ReportRange } = require("../utils/dateRange");

// normalize to the Sale model enum
function normalizePaymentMethod(pm) {
  const v = String(pm || "cash").toLowerCase();
  if (v === "cash") return "cash";
  if (v === "card") return "card";
  if (
    ["mpesa", "m-pesa", "bank", "transfer", "wire", "bank transfer"].includes(v)
  ) {
    return "transfer";
  }
  return "other";
}

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function toPositiveInteger(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function buildSaleQuantities(item, piecesPerCarton) {
  const paidCartons = toNonNegativeInteger(item?.cartonQuantity, 0);
  const paidLoosePieces = toNonNegativeInteger(
    item?.looseQuantity ?? item?.paidPieces,
    0
  );
  const bonusCartons = toNonNegativeInteger(item?.bonusCartons, 0);
  const bonusPieces = toNonNegativeInteger(item?.bonusPieces, 0);

  if (paidLoosePieces >= piecesPerCarton || bonusPieces >= piecesPerCarton) {
    return {
      error: `Les piÃ¨ces doivent Ãªtre infÃ©rieures Ã  ${piecesPerCarton} par carton`,
    };
  }

  const boxedPaidQuantity = paidCartons * piecesPerCarton + paidLoosePieces;
  const boxedBonusQuantity = bonusCartons * piecesPerCarton + bonusPieces;
  const paidQuantity =
    boxedPaidQuantity > 0
      ? boxedPaidQuantity
      : toNonNegativeInteger(item?.paidQuantity ?? item?.quantity, 0);
  const bonusQuantity =
    boxedBonusQuantity > 0
      ? boxedBonusQuantity
      : toNonNegativeInteger(item?.bonusQuantity, 0);
  const paidParts =
    boxedPaidQuantity > 0
      ? { cartons: paidCartons, pieces: paidLoosePieces }
      : {
          cartons: Math.floor(paidQuantity / piecesPerCarton),
          pieces: paidQuantity % piecesPerCarton,
        };
  const bonusParts =
    boxedBonusQuantity > 0
      ? { cartons: bonusCartons, pieces: bonusPieces }
      : {
          cartons: Math.floor(bonusQuantity / piecesPerCarton),
          pieces: bonusQuantity % piecesPerCarton,
        };

  return {
    paidQuantity,
    bonusQuantity,
    quantity: paidQuantity + bonusQuantity,
    cartonQuantity: paidParts.cartons,
    looseQuantity: paidParts.pieces,
    bonusCartons: bonusParts.cartons,
    bonusPieces: bonusParts.pieces,
  };
}

function getLineTotal(paidPieces, piecesPerCarton, boxPrice) {
  return Number(boxPrice) * (Number(paidPieces) / Math.max(1, Number(piecesPerCarton || 1)));
}

const VALID_REVENUE_STATUS_FILTER = {
  $nin: ["voided", "corrected", "cancelled", "refunded"],
};
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedCreditStages() {
  return [
    { $set: { "creditDetails.payments": { $ifNull: ["$creditDetails.payments", []] } } },
    { $set: {
      _confirmedPaid: { $round: [{ $cond: [
        { $gt: [{ $size: "$creditDetails.payments" }, 0] },
        { $sum: { $map: { input: "$creditDetails.payments", as: "payment", in: { $cond: [
          { $in: [{ $ifNull: ["$$payment.status", "confirmed"] }, ["confirmed"]] },
          { $ifNull: ["$$payment.amount", 0] }, 0,
        ] } } } },
        { $ifNull: ["$creditDetails.amountPaid", 0] },
      ] }, 2] },
      _pendingPaid: { $round: [{ $cond: [
        { $gt: [{ $size: "$creditDetails.payments" }, 0] },
        { $sum: { $map: { input: "$creditDetails.payments", as: "payment", in: { $cond: [{ $eq: ["$$payment.status", "pending"] }, { $ifNull: ["$$payment.amount", 0] }, 0] } } } },
        { $ifNull: ["$creditDetails.pendingAmount", 0] },
      ] }, 2] },
    } },
    { $set: {
      _outstanding: { $max: [0, { $round: [{ $subtract: ["$total", "$_confirmedPaid"] }, 2] }] },
      "creditDetails.amountPaid": "$_confirmedPaid",
      "creditDetails.pendingAmount": "$_pendingPaid",
    } },
    { $set: {
      "creditDetails.amountDue": "$_outstanding",
      "creditDetails.fullyPaid": { $lte: ["$_outstanding", DEBT_TOLERANCE] },
    } },
  ];
}

// Revenue is cash actually received: immediate-payment sales at sale time, plus
// credit payments at the time the seller confirms receipt. Credit invoices are
// deliberately absent until that confirmation happens.
async function getReceivedRevenue(createdAt, scope = {}, branchId = "butembo") {
  const validSaleMatch = {
    $and: [
      {
        status: VALID_REVENUE_STATUS_FILTER,
        type: { $in: ["sale", "reservation"] },
      },
      scope,
      branchScope(branchId),
    ],
  };

  const [cashSales, creditPayments] = await Promise.all([
    Sale.aggregate([
      {
        $match: {
          ...validSaleMatch,
          paymentType: { $ne: "credit" },
          createdAt,
        },
      },
      {
        $project: {
          _id: 0,
          saleId: 1,
          amount: "$total",
          receivedAt: "$createdAt",
          kind: { $literal: "cash_sale" },
        },
      },
    ]),
    Sale.aggregate([
      { $match: { ...validSaleMatch, paymentType: "credit" } },
      { $unwind: "$creditDetails.payments" },
      {
        $match: {
          // Payments written before confirmation states were introduced were
          // already treated as received, so retain that historical meaning.
          $or: [
            { "creditDetails.payments.status": "confirmed" },
            { "creditDetails.payments.status": { $exists: false } },
          ],
        },
      },
      {
        $project: {
          _id: 0,
          saleId: 1,
          amount: "$creditDetails.payments.amount",
          receivedAt: {
            $ifNull: [
              "$creditDetails.payments.paymentDate",
              { $ifNull: ["$creditDetails.payments.confirmedAt", "$creditDetails.payments.date"] },
            ],
          },
          kind: { $literal: "credit_payment" },
        },
      },
      { $match: { receivedAt: createdAt } },
    ]),
  ]);

  const cashAmount = cashSales.reduce((sum, event) => sum + Number(event.amount || 0), 0);
  const creditAmount = creditPayments.reduce(
    (sum, event) => sum + Number(event.amount || 0),
    0
  );
  return {
    amount: cashAmount + creditAmount,
    cashAmount,
    creditAmount,
    cashSaleCount: cashSales.length,
    confirmedCreditPaymentCount: creditPayments.length,
    events: [...cashSales, ...creditPayments].sort(
      (a, b) => new Date(a.receivedAt) - new Date(b.receivedAt)
    ),
  };
}

// Helper function to update customer data (FIXED)
async function updateCustomerData(customerData, saleTotal, branchId, session = null) {
  const { name, phone, email } = customerData;
  const now = new Date();
  try {
    let customerQuery = Customer.findOne({ phone });
    if (session) customerQuery = customerQuery.session(session);
    let customer = await customerQuery;
    if (customer) {
      if (branchId !== "butembo" && !customer.branchStats?.get("butembo")) {
        customer.branchStats = customer.branchStats || new Map();
        customer.branchStats.set("butembo", {
          totalPurchases: Number(customer.totalPurchases || 0),
          totalSpent: Number(customer.totalSpent || 0),
          firstPurchaseDate: customer.firstPurchaseDate || null,
          lastPurchaseDate: customer.lastPurchaseDate || null,
        });
      }
      customer.totalPurchases += 1;
      customer.totalSpent += parseFloat(saleTotal);
      customer.lastPurchaseDate = now;
      if (name && customer.name !== name) customer.name = name;
      if (email && customer.email !== email) customer.email = email;
      customer.branches = Array.from(new Set([...(customer.branches || ["butembo"]), branchId]));
      const previousBranchStats = customer.branchStats?.get(branchId) || (branchId === "butembo" ? {
        totalPurchases: Number(customer.totalPurchases || 0) - 1,
        totalSpent: Number(customer.totalSpent || 0) - parseFloat(saleTotal),
        firstPurchaseDate: customer.firstPurchaseDate || now,
      } : {
        totalPurchases: 0,
        totalSpent: 0,
        firstPurchaseDate: now,
      });
      customer.branchStats = customer.branchStats || new Map();
      customer.branchStats.set(branchId, {
        totalPurchases: Number(previousBranchStats.totalPurchases || 0) + 1,
        totalSpent: Number(previousBranchStats.totalSpent || 0) + parseFloat(saleTotal),
        firstPurchaseDate: previousBranchStats.firstPurchaseDate || now,
        lastPurchaseDate: now,
      });
    } else {
      customer = new Customer({
        name,
        phone,
        email: email || "",
        totalPurchases: 1,
        totalSpent: parseFloat(saleTotal),
        firstPurchaseDate: now,
        lastPurchaseDate: now,
        branches: [branchId],
        branchStats: {
          [branchId]: { totalPurchases: 1, totalSpent: parseFloat(saleTotal), firstPurchaseDate: now, lastPurchaseDate: now },
        },
      });
    }
    await customer.save(session ? { session } : undefined);
    
    // RETURN THE CUSTOMER ID
    return customer._id;
  } catch (error) {
    console.error("Error updating customer data:", error);
    if (session) throw error;
    return null;
  }
}

// Helper function to recalculate customer statistics (FIXED)
async function recalculateCustomerStats(customerId, branchId) {
  try {
    // FIX: Only include completed sales (exclude voided and corrected)
    const sales = await Sale.find(scopedFilter({
      customerId: customerId,
      status: { $in: ["completed", "pending", undefined, null] } // Only valid sales
    }, branchId))
    .sort({ createdAt: 1 })
    .select('total status type createdAt') // Only select needed fields
    .lean();
    
    // Additional safety filter
    const validSales = sales.filter(sale => 
      sale.status !== "voided" && sale.status !== "corrected" && sale.type !== "expense"
    );
    
    if (validSales.length === 0) {
      await Customer.findByIdAndUpdate(customerId, { $set: { [`branchStats.${branchId}`]: {
        totalPurchases: 0, totalSpent: 0, firstPurchaseDate: null, lastPurchaseDate: null,
      } } });
      return;
    }
    
    const totalPurchases = validSales.length;
    const totalSpent = validSales.reduce((sum, sale) => sum + sale.total, 0);
    const firstPurchaseDate = validSales[0].createdAt;
    const lastPurchaseDate = validSales[validSales.length - 1].createdAt;

    await Customer.findByIdAndUpdate(customerId, {
      $set: { [`branchStats.${branchId}`]: { totalPurchases, totalSpent, firstPurchaseDate, lastPurchaseDate } },
    });
  } catch (error) {
    console.error("Error recalculating customer stats:", error);
    throw error;
  }
}

// ==================== TIME FRAME HELPER FUNCTIONS ====================
//
// Both helpers below delegate to utils/dateRange.js — the single authoritative
// GMT+2 boundary calculator shared with the reporting endpoints (see
// routes/companyReport.js). Previously this file computed boundaries with
// `new Date(); date.setHours(0,0,0,0)`, which uses the Node process's own
// timezone (UTC on Render) instead of the GMT+2 business timezone, silently
// shifting "today"/day/month/year boundaries by up to 2 hours. The public
// query-parameter contract (from/to/date/year/month, default today) and the
// returned filter's `createdAt.$gte` field are unchanged; the upper bound is
// now `$lt` (exclusive next-boundary instant) instead of an inclusive
// `$lte` end-of-day instant — this is the boundary style utils/dateRange.js
// uses everywhere and avoids millisecond-precision edge cases at day seams.

/**
 * Build date range filter based on timeframe parameters
 * Follows priority: custom range > specific day > month > year > today
 * @param {Object} query - Request query parameters
 * @returns {Object} MongoDB date filter { createdAt: { $gte, $lt } }
 */
function buildTimeframeFilter(query) {
  const { start, end } = getGmt2ReportRange(query);
  return { createdAt: { $gte: start, $lt: end } };
}

/**
 * Get human-readable timeframe description
 */
function getTimeframeDescription(query) {
  return getGmt2ReportRange(query).description;
}

// ==================== MAIN SALES ENDPOINT (TIME FRAME PAGINATION) ====================

/** 
 * GET /api/sales
 * Timeframe-based pagination (no numeric pagination)
 * Priority: custom range > specific day > month > year > today (default)
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { page, limit } = parsePagination(req.query);
    const { 
      customerPhone, 
      status,
      type,
      creditFilter
    } = req.query;
    
    // Build the main filter object
    const filter = {};
    
    // 1. Apply timeframe filter (priority order handled in buildTimeframeFilter)
    try {
      const timeframeFilter = buildTimeframeFilter(req.query);
      Object.assign(filter, timeframeFilter);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD for dates, YYYY for year, MM for month (01-12)"
      });
    }
    
    // 2. Apply customer phone filter if provided
    if (customerPhone) {
      filter["customer.phone"] = customerPhone;
    }
    
    // 3. Apply status filter if provided, otherwise use default
    if (status) {
      filter.status = status;
    } else {
      // Default: include completed, pending, and expense statuses
      filter.status = { $in: ["completed", "pending", "expense"] };
    }
    
    // 4. Apply type filter if provided, otherwise use default
    if (type) {
      filter.type = type;
    } else {
      // Default: include all types
      filter.type = { $in: ["sale", "reservation", "expense"] };
    }
    if (creditFilter && creditFilter !== "all") {
      filter.paymentType = "credit";
      if (creditFilter === "credit_pending") {
        filter["creditDetails.amountPaid"] = { $lte: 0 };
        filter["creditDetails.amountDue"] = { $gt: 0 };
      } else if (creditFilter === "credit_partial") {
        filter["creditDetails.amountPaid"] = { $gt: 0 };
        filter["creditDetails.amountDue"] = { $gt: 0 };
      } else if (creditFilter === "credit_paid") {
        filter["creditDetails.fullyPaid"] = true;
      }
    }
    
    // Execute query - get ALL records within timeframe (no skip/limit)
    const pageResult = await aggregatePage(
      Sale,
      scopedFilter(filter, req.branchId),
      page,
      limit,
      {
        operationalTotals: [{
          $group: {
            _id: null,
            totalExpenses: { $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$total", 0] } },
            saleCount: { $sum: { $cond: [{ $ne: ["$type", "expense"] }, 1, 0] } },
            expenseCount: { $sum: { $cond: [{ $eq: ["$type", "expense"] }, 1, 0] } },
          },
        }],
      }
    );
    const sales = pageResult.data.map(normalizeCreditSaleDocument);
    const total = pageResult.pagination.totalRecords;
    
    // Generate timeframe metadata
    const timeframeDescription = getTimeframeDescription(req.query);
    const timeframeFilter = buildTimeframeFilter(req.query);
    
    // Calculate operational totals for quick insights. Revenue itself is
    // calculated from receipt events below, not from credit invoice totals.
    const totals = pageResult.facets.operationalTotals?.[0] || {
      totalExpenses: 0, saleCount: 0, expenseCount: 0,
    };
    const revenueScope = {
      ...(customerPhone && { "customer.phone": customerPhone }),
      ...(status ? { status } : { status: { $in: ["completed", "pending", "expense"] } }),
      ...(type && { type }),
    };
    const receivedRevenue = await getReceivedRevenue(
      timeframeFilter.createdAt,
      revenueScope,
      req.branchId
    );
    
    // Prepare response with timeframe metadata
    const response = {
      success: true,
      data: sales,
      timeframe: {
        description: timeframeDescription,
        start: timeframeFilter.createdAt.$gte.toISOString(),
        end: timeframeFilter.createdAt.$lt.toISOString(),
        query: {
          from: req.query.from || null,
          to: req.query.to || null,
          date: req.query.date || null,
          year: req.query.year || null,
          month: req.query.month || null
        }
      },
      summary: {
        totalRecords: total,
        revenue: receivedRevenue.amount,
        cashSalesRevenue: receivedRevenue.cashAmount,
        confirmedCreditPayments: receivedRevenue.creditAmount,
        confirmedCreditPaymentCount: receivedRevenue.confirmedCreditPaymentCount,
        expenses: totals.totalExpenses,
        net: receivedRevenue.amount - totals.totalExpenses,
        salesCount: totals.saleCount,
        expensesCount: totals.expenseCount
      },
      pagination: pageResult.pagination,
      revenueEvents: receivedRevenue.events,
      filtersApplied: {
        customerPhone: customerPhone || 'none',
        status: status || 'default (completed, pending, expense)',
        type: type || 'default (sale, reservation, expense)'
      },
      // Performance warning for large datasets
      performanceNote: total > 1000 
        ? `Large dataset (${total} records). Consider using a more specific timeframe.`
        : null
    };
    
    res.json(response);
    
  } catch (error) {
    console.error("Error fetching sales with timeframe pagination:", error);
    
    // Handle specific error types
    if (error.message.includes("Invalid date format") || 
        error.message.includes("Invalid year") || 
        error.message.includes("Invalid month")) {
      return res.status(400).json({ 
        error: error.message,
        validFormats: {
          date: "YYYY-MM-DD (e.g., 2024-12-25)",
          month: "year=YYYY&month=MM (e.g., year=2024&month=12)",
          year: "year=YYYY (e.g., year=2024)",
          customRange: "from=YYYY-MM-DD&to=YYYY-MM-DD"
        }
      });
    }
    
    res.status(500).json({ 
      error: "Failed to fetch sales",
      suggestion: "Check your query parameters and try again"
    });
  }
});

/** ---------- ALL OUTSTANDING CREDIT SALES (not restricted by sale date) ---------- **/
router.get("/unpaid", authMiddleware, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const now = new Date();
    const baseMatch = scopedFilter({
      paymentType: "credit",
      status: { $nin: ["voided", "corrected", "refunded", "cancelled"] },
      type: { $in: ["sale", "reservation"] },
    }, req.branchId);
    const pipeline = [{ $match: baseMatch }, ...normalizedCreditStages(), { $match: { _outstanding: { $gt: DEBT_TOLERANCE } } }];

    const search = String(req.query.search || "").trim();
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      pipeline.push({ $match: { $or: [
        { "customer.name": regex }, { "customer.phone": regex },
        { saleId: regex }, { saleNumber: regex },
      ] } });
    }
    if (req.query.debtStatus === "unpaid") pipeline.push({ $match: { _confirmedPaid: { $lte: DEBT_TOLERANCE } } });
    if (req.query.debtStatus === "partial") pipeline.push({ $match: { _confirmedPaid: { $gt: DEBT_TOLERANCE } } });
    if (req.query.debtStatus === "overdue") pipeline.push({ $match: { "creditDetails.dueDate": { $lt: now } } });
    const dueDate = {};
    const dueFrom = req.query.dueFrom ? parsePaymentDate(req.query.dueFrom) : null;
    const dueTo = req.query.dueTo ? parsePaymentDate(req.query.dueTo) : null;
    if ((req.query.dueFrom && !dueFrom) || (req.query.dueTo && !dueTo)) {
      return res.status(400).json({ error: "Période d'échéance invalide" });
    }
    if (dueFrom) dueDate.$gte = new Date(`${dueFrom.calendarDate}T00:00:00+02:00`);
    if (dueTo) dueDate.$lte = new Date(`${dueTo.calendarDate}T23:59:59.999+02:00`);
    if (Object.keys(dueDate).length) pipeline.push({ $match: { "creditDetails.dueDate": dueDate } });

    pipeline.push({ $sort: { "creditDetails.dueDate": 1, createdAt: 1, _id: 1 } });
    pipeline.push({ $facet: {
      data: [{ $skip: skip }, { $limit: limit }, { $unset: ["_confirmedPaid", "_pendingPaid", "_outstanding", "__v"] }],
      summary: [{ $group: {
        _id: null,
        totalDebtInvoices: { $sum: 1 },
        totalCreditInvoiced: { $sum: "$total" },
        totalConfirmedPaid: { $sum: "$_confirmedPaid" },
        totalOutstanding: { $sum: "$_outstanding" },
        totalPendingPayments: { $sum: "$_pendingPaid" },
        fullyUnpaidCount: { $sum: { $cond: [{ $lte: ["$_confirmedPaid", DEBT_TOLERANCE] }, 1, 0] } },
        partiallyPaidCount: { $sum: { $cond: [{ $gt: ["$_confirmedPaid", DEBT_TOLERANCE] }, 1, 0] } },
        overdueCount: { $sum: { $cond: [{ $and: [{ $ne: ["$creditDetails.dueDate", null] }, { $lt: ["$creditDetails.dueDate", now] }] }, 1, 0] } },
      } }],
    } });
    const [result = {}] = await Sale.aggregate(pipeline);
    const summary = result.summary?.[0] || {
      totalDebtInvoices: 0, totalCreditInvoiced: 0, totalConfirmedPaid: 0,
      totalOutstanding: 0, totalPendingPayments: 0, fullyUnpaidCount: 0,
      partiallyPaidCount: 0, overdueCount: 0,
    };

    res.json({
      success: true,
      data: result.data || [],
      pagination: paginationMeta(page, limit, summary.totalDebtInvoices),
      summary,
    });
  } catch (error) {
    console.error("Error fetching unpaid credit sales:", error);
    res.status(500).json({ error: "Failed to fetch unpaid credit sales" });
  }
});

// ==================== ALL OTHER ROUTES REMAIN UNCHANGED ====================

/** ---------- DAILY STATS FIRST (before :id) ---------- **/
router.get("/stats/daily", authMiddleware, async (req, res) => {
  try {
    const { date } = req.query;
    // GMT+2 business-day boundaries (see utils/dateRange.js) — not the
    // server process's own timezone.
    const { start: startOfDay, end: endOfDay } = getGmt2ReportRange(
      date ? { date } : {}
    );

    const dailySales = await Sale.aggregate([
      {
        $match: scopedFilter({
          createdAt: { $gte: startOfDay, $lt: endOfDay },
          // ✅ FIXED: INCLUDE PENDING RESERVATIONS (money already received)
          status: { $in: ["completed", "pending"] },
          // ✅ FIXED: INCLUDE BOTH SALES AND RESERVATIONS
          type: { $in: ["sale", "reservation"] }
        }, req.branchId),
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalItems: { $sum: { $size: "$items" } },
        },
      },
    ]);

    // Use timeframe-based query (no limit) for consistency
    const sales = await Sale.find(scopedFilter({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
      status: { $in: ["completed", "pending"] },
      type: { $in: ["sale", "reservation"] }
    }, req.branchId))
    .sort({ createdAt: -1 })
    .select('-__v')
    .lean();

    const receivedRevenue = await getReceivedRevenue({
      $gte: startOfDay,
      $lt: endOfDay,
    }, {}, req.branchId);

    // GMT+2 calendar date represented by this range, as YYYY-MM-DD.
    const gmt2DateLabel = new Date(startOfDay.getTime() + 2 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    res.json({
      date: date || gmt2DateLabel,
      totalSales: dailySales[0]?.totalSales || 0,
      totalRevenue: receivedRevenue.amount,
      cashSalesRevenue: receivedRevenue.cashAmount,
      confirmedCreditPayments: receivedRevenue.creditAmount,
      revenueEvents: receivedRevenue.events,
      totalItems: dailySales[0]?.totalItems || 0,
      sales,
    });
  } catch (error) {
    console.error("Error fetching daily stats:", error);
    res.status(500).json({ error: "Failed to fetch daily statistics" });
  }
});

/** ---------- CREATE SALE OR EXPENSE ---------- **/
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      customer,
      items,
      paymentMethod,
      salesPerson,
      type,
      reservationDate,
      reservationTime,
      notes,
      // CREDIT FIELDS
      paymentType,
      creditAmountPaid,
      creditDueDate,
      // 🔹 NEW EXPENSE FIELDS
      reason,
      recipientName,
      recipientPhone,
      amount,
      recordedBy,
      // 🔹 Admin-only: backdate/forward-date which calendar day this sale belongs to
      saleDate,
    } = req.body;

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // Only superadmins may pick a different day for the sale to be recorded
    // under. NOTE: req.user.isSuperAdmin (see utils/branchContext.js) is true
    // for role "admin" too despite its name — plain "admin" must NOT get this
    // power, so we check req.user.role directly here rather than that flag.
    // Mongoose's `timestamps: true` only auto-fills `createdAt` when it isn't
    // already set, so assigning it here makes the sale appear/be calculated
    // under that date everywhere createdAt is used for filtering (SalesHistory,
    // CompanyReport, etc.) — the time-of-day is kept as "now" so ordering within
    // the day stays chronological.
    let customCreatedAt = null;
    if (saleDate && req.user?.role === "superadmin") {
      const datePart = String(saleDate).slice(0, 10);
      const now = new Date();
      const timeOfDay = [
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join(":");
      const candidate = new Date(`${datePart}T${timeOfDay}`);
      if (!Number.isNaN(candidate.getTime())) {
        customCreatedAt = candidate;
      }
    }

    // 🔹 HANDLE EXPENSE TYPE
    if (type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = parseFloat(amount);
      if (isNaN(expenseAmount) || expenseAmount <= 0) {
        return res.status(400).json({ 
          error: "Amount must be a positive number" 
        });
      }

      const saleId = `EXP-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 5)
        .toUpperCase()}`;

      const saleNumber = `EXP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const expenseData = {
        branchId: req.branchId,
        saleId,
        saleNumber,
        customer: {
          name: recipientName,
          phone: recipientPhone,
          email: "",
        },
        items: [], // No items for expenses
        subtotal: expenseAmount,
        total: expenseAmount,
        paymentMethod: normalizedPM,
        status: "expense", // 🔹 Special status for expenses
        salesPerson: req.user.username || req.user.name || "Unknown",
        type: "expense",
        reason: reason,
        recipientName: recipientName,
        recipientPhone: recipientPhone,
        notes: notes || ""
      };

      const expense = new Sale(expenseData);
      const savedExpense = await expense.save();

      return res.status(201).json(savedExpense);
    }

    // 🔹 HANDLE REGULAR SALE (existing logic)
    // Credit sales require customer identification; normal sales have optional customer info
    if (paymentType === "credit") {
      if (!customer || !customer.name || !customer.phone) {
        return res
          .status(400)
          .json({ error: "Customer name and phone are required for credit sales" });
      }
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "Sale must contain at least one item" });
    }

    let subtotal = 0;
    const enrichedItems = [];
    for (const item of items) {
      const { productId, price, name } = item || {};
      const unitPrice = Number(price);

      if (!productId || !Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({
          error: "Chaque article exige productId, quantité vendue > 0, et prix >= 0",
        });
      }

      const product = await Product.findOne(
        scopedFilter({ _id: productId }, req.branchId)
      ).lean();
      if (!product)
        return res
          .status(400)
          .json({ error: `Product not found: ${productId}` });

      if (product.status !== "active") {
        return res.status(400).json({
          error: `Cannot sell inactive product: ${product.name || productId}`,
        });
      }

      const piecesPerCarton = toPositiveInteger(product.piecesPerCarton, 1);
      const quantityPayload = buildSaleQuantities(item, piecesPerCarton);
      if (quantityPayload.error) {
        return res.status(400).json({ error: quantityPayload.error });
      }

      const {
        paidQuantity,
        bonusQuantity,
        quantity,
        cartonQuantity,
        looseQuantity,
        bonusCartons,
        bonusPieces,
      } = quantityPayload;
      if (quantity <= 0) {
        return res.status(400).json({
          error: "Chaque article exige une quantite ou un bonus superieur a zero",
        });
      }
      if (paidQuantity > 0 && unitPrice <= 0) {
        return res.status(400).json({
          error: "Le prix par boite doit etre superieur a zero",
        });
      }

      const availableStock = product.stock;
      if (availableStock < quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${
            product.name || name || productId
          }. Available: ${availableStock}`,
        });
      }

      const lineTotal = getLineTotal(paidQuantity, piecesPerCarton, unitPrice);
      subtotal += lineTotal;

      enrichedItems.push({
        productId: new mongoose.Types.ObjectId(productId),
        name: String(name || product.name).trim().slice(0, 120),
        quantity,
        paidQuantity,
        bonusQuantity,
        cartonQuantity,
        looseQuantity,
        bonusCartons,
        bonusPieces,
        piecesPerCarton,
        boxPrice: unitPrice,
        price: unitPrice,
        total: lineTotal,
        previousStock: availableStock,
      });
    }

    const total = subtotal;

    const saleId = `Vente-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)
      .toUpperCase()}`;

    const saleNumber = `SN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Capture the active exchange rate at the moment of sale (frozen for historical accuracy)
    const rateRecord = await ExchangeRate.getCurrentRate(req.branchId);
    const capturedRate = rateRecord ? rateRecord.rate : null;

    // Build credit details if this is a credit sale
    const isCreditSale = paymentType === "credit";
    let creditDetailsData = undefined;

    if (isCreditSale) {
      const initialPaid = Math.round(
        Math.max(0, parseFloat(creditAmountPaid) || 0) * 100
      ) / 100;
      if (initialPaid > total + 0.001) {
        return res.status(400).json({
          error: "Le montant versé ne peut pas dépasser le total de la vente",
        });
      }
      creditDetailsData = {
        // Saving the sale confirms that this advance was actually received.
        amountPaid: initialPaid,
        amountDue: Math.max(0, Math.round((total - initialPaid) * 100) / 100),
        pendingAmount: 0,
        dueDate: creditDueDate ? new Date(creditDueDate) : null,
        fullyPaid: total - initialPaid <= 0.009,
        payments:
          initialPaid > 0
            ? [
                {
                  paymentId: randomUUID(),
                  amount: initialPaid,
                  paymentDate: customCreatedAt
                    ? parsePaymentDate(String(saleDate).slice(0, 10)).value
                    : new Date(),
                  recordedAt: new Date(),
                  date: new Date(),
                  method: normalizedPM,
                  recordedBy: req.user.username || req.user.name || "Unknown",
                  notes: "Versement initial",
                  status: "confirmed",
                  confirmedAt: new Date(),
                  confirmedBy: req.user.username || req.user.id,
                },
              ]
            : [],
      };
    }

    // UPDATED: Include type and reservation fields WITH CORRECT STATUS
    const saleData = {
      branchId: req.branchId,
      saleId,
      saleNumber,
      customer: {
        name: customer?.name || "",
        phone: customer?.phone || "",
        email: customer?.email || "",
      },
      customerId: null,
      items: enrichedItems,
      subtotal,
      total,
      paymentMethod: normalizedPM,
      paymentType: isCreditSale ? "credit" : "cash",
      ...(creditDetailsData && { creditDetails: creditDetailsData }),
      status: type === "reservation" ? "pending" : "completed",
      salesPerson: req.user.username || req.user.name || "Unknown",
      type: type || "sale",
      reservationDate: reservationDate || null,
      reservationTime: reservationTime || null,
      notes: notes || "",
      exchangeRate: capturedRate,
      ...(customCreatedAt && { createdAt: customCreatedAt }),
    };

    const session = await mongoose.startSession();
    let savedSale;
    try {
      session.startTransaction();

      // Customer statistics and the sale belong to one business transaction:
      // neither may survive if stock validation or sale persistence fails.
      if (customer?.phone) {
        saleData.customerId = await updateCustomerData(customer, total, req.branchId, session);
      }

      for (const it of enrichedItems) {
        const updated = await adjustBranchStock({
          productId: it.productId,
          branchId: req.branchId,
          delta: -it.quantity,
          requireAvailable: true,
          session,
        });
        if (!updated) {
          await session.abortTransaction();
          await session.endSession();
          return res.status(409).json({
            error: "Stock changed for an item. Please refresh and try again.",
          });
        }
      }

      const sale = new Sale(saleData);
      savedSale = await sale.save({ session });

      if (enrichedItems.length > 0) {
        await StockMovement.create(
          enrichedItems.map((it) => ({
            productId: it.productId,
            productName: it.name,
            type: "sale",
            quantity: it.quantity,
            piecesPerCarton: it.piecesPerCarton,
            paidCartons: it.cartonQuantity,
            paidPieces: it.looseQuantity,
            bonusCartons: it.bonusCartons,
            bonusPieces: it.bonusPieces,
            reference: savedSale.saleId,
            notes: customer?.name ? `Vente à ${customer.name}` : "Vente",
            recordedBy: req.user.name || req.user.username || "Unknown",
            recordedByUserId: req.user.id,
            recordedByRole: req.user.role,
            branchId: req.branchId,
            previousStock: it.previousStock,
            newStock: it.previousStock - it.quantity,
          })),
          { session, ordered: true }
        );
      }

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    return res.status(201).json(savedSale);
  } catch (error) {
    console.error("SALE ERROR:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    return res.status(500).json({
      error: error.message || "Failed to create sale/expense",
      ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
    });
  }
});

// ==================== MODIFIED ENDPOINTS (REMOVE PAGINATION) ====================

/** ---------- GET EXPENSES (TIME FRAME BASED) ---------- **/
router.get("/expenses/all", authMiddleware, async (req, res) => {
  try {
    const { 
      status 
    } = req.query;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }
    
    const filter = { 
      type: "expense",
      ...timeframeFilter
    };
    
    if (status) {
      filter.status = status;
    }

    const expenses = await Sale.find(scopedFilter(filter, req.branchId))
      .select('-__v -items') // Expenses don't have items
      .sort({ createdAt: -1 })
      .lean();

    const total = expenses.length;
    const totalAmount = expenses.reduce((sum, expense) => sum + expense.total, 0);

    res.json({
      success: true,
      data: expenses,
      summary: {
        totalExpenses: total,
        totalAmount: totalAmount,
        timeframe: getTimeframeDescription(req.query)
      }
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

/** ---------- GET RESERVATIONS (TIME FRAME BASED) ---------- **/
router.get("/reservations/all", authMiddleware, async (req, res) => {
  try {
    const { 
      status 
    } = req.query;
    
    // Build timeframe filter
    let timeframeFilter;
    try {
      timeframeFilter = buildTimeframeFilter(req.query);
    } catch (timeframeError) {
      return res.status(400).json({ 
        error: timeframeError.message,
        suggestion: "Use valid date formats: YYYY-MM-DD"
      });
    }
    
    const filter = { 
      type: "reservation",
      ...timeframeFilter
    };
    
    if (status) {
      filter.status = status;
    }

    const reservations = await Sale.find(scopedFilter(filter, req.branchId))
      .select('-__v') // Exclude version key
      .sort({ createdAt: -1 })
      .lean();

    const total = reservations.length;
    const pendingCount = reservations.filter(r => r.status === "pending").length;
    const completedCount = reservations.filter(r => r.status === "completed").length;

    res.json({
      success: true,
      data: reservations,
      summary: {
        totalReservations: total,
        pending: pendingCount,
        completed: completedCount,
        timeframe: getTimeframeDescription(req.query)
      }
    });
  } catch (error) {
    console.error("Error fetching reservations:", error);
    res.status(500).json({ error: "Failed to fetch reservations" });
  }
});

// ==================== ALL OTHER ROUTES REMAIN EXACTLY THE SAME ====================

/** ---------- GET BY ID (after other specific routes) ---------- **/
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const saleId = req.params.id;
    
    const sale = await Sale.findOne(scopedFilter({ _id: saleId }, req.branchId))
      .select('-__v') // Exclude version key
      .lean();
    
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // Only check for duplicates if needed
    let potentialDuplicates = [];
    let duplicateCount = 0;
    
    if (sale.saleId) {
      potentialDuplicates = await Sale.find(scopedFilter({
        saleId: sale.saleId,
        _id: { $ne: saleId }
      }, req.branchId))
      .select('_id saleId createdAt status')
      .lean();
      
      duplicateCount = potentialDuplicates.length;
    }

    res.json({
      success: true,
      data: sale,
      duplicates: {
        count: duplicateCount,
        items: potentialDuplicates
      },
      message: duplicateCount > 0 ? 
        `Found ${duplicateCount} potential duplicates` : 
        "No duplicates found"
    });

  } catch (error) {
    console.error("Error fetching sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID format" });
    }
    res.status(500).json({ error: "Failed to fetch sale" });
  }
});

/** ---------- EDIT SALE (Role-Based Restrictions) ---------- **/
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      customer, 
      items, 
      paymentMethod, 
      reason, 
      type, 
      reservationDate, 
      reservationTime, 
      notes,
      // Expense fields
      recipientName,
      recipientPhone,
      amount
    } = req.body;

    // Find the original sale
    const originalSale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
    if (!originalSale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // 🔹 NEW: RESTRICTION FOR RESERVATIONS
    if (originalSale.type === "reservation") {
      const userRole = req.user.role;
      
      // If reservation is completed, only admin can edit
      if (originalSale.status === "completed" && !req.user.isSuperAdmin) {
        return res.status(403).json({ 
          error: "Only admin can edit completed reservations" 
        });
      }
      
      // If reservation is pending, only admin and manager can edit
      if (originalSale.status === "pending" &&
          !req.user.isSuperAdmin && userRole !== "manager") {
        return res.status(403).json({ 
          error: "Only admin and manager can edit pending reservations" 
        });
      }
    }

    // Prevent editing voided or corrected sales
    if (originalSale.status === "voided" || originalSale.status === "corrected") {
      return res.status(400).json({ 
        error: "Cannot edit a voided or corrected sale" 
      });
    }

    const normalizedPM = normalizePaymentMethod(paymentMethod);

    // 🔹 HANDLE EXPENSE EDITING
    if (originalSale.type === "expense" || type === "expense") {
      if (!reason || !recipientName || !recipientPhone || !amount) {
        return res.status(400).json({ 
          error: "Expense requires reason, recipientName, recipientPhone, and amount" 
        });
      }

      const expenseAmount = parseFloat(amount);
      if (isNaN(expenseAmount) || expenseAmount <= 0) {
        return res.status(400).json({ 
          error: "Amount must be a positive number" 
        });
      }

      // Track changes for audit
      const changes = new Map();
      
      if (originalSale.reason !== reason) {
        changes.set('reason', { from: originalSale.reason, to: reason });
      }
      if (originalSale.recipientName !== recipientName) {
        changes.set('recipientName', { from: originalSale.recipientName, to: recipientName });
      }
      if (originalSale.recipientPhone !== recipientPhone) {
        changes.set('recipientPhone', { from: originalSale.recipientPhone, to: recipientPhone });
      }
      if (originalSale.total !== expenseAmount) {
        changes.set('total', { from: originalSale.total, to: expenseAmount });
      }

      const updatedExpense = await Sale.findOneAndUpdate(
        scopedFilter({ _id: id }, req.branchId),
        {
          reason,
          recipientName,
          recipientPhone,
          subtotal: expenseAmount,
          total: expenseAmount,
          paymentMethod: normalizedPM,
          notes: notes || originalSale.notes,
          editedBy: req.user.id,
          editedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.id,
              editedAt: new Date(),
              changes: Object.fromEntries(changes),
              reason: reason || "Expense correction"
            }
          }
        },
        { new: true, runValidators: true }
      );

      return res.json(updatedExpense);
    }

    // 🔹 HANDLE REGULAR SALE EDITING
    // Track changes for audit
    const changes = new Map();

    // Validate and process items
    let subtotal = 0;
    const enrichedItems = [];
    
    for (const item of items) {
      const { productId, price, name } = item || {};
      const unitPrice = Number(price);
      if (!productId || !Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({
          error: "Each item requires productId, quantity>0, and price>0",
        });
      }

      const product = await Product.findOne(
        scopedFilter({ _id: productId }, req.branchId)
      ).lean();
      if (!product) {
        return res.status(400).json({ error: `Product not found: ${productId}` });
      }

      const piecesPerCarton = toPositiveInteger(product.piecesPerCarton, 1);
      const quantityPayload = buildSaleQuantities(item, piecesPerCarton);
      if (quantityPayload.error) {
        return res.status(400).json({ error: quantityPayload.error });
      }

      const {
        paidQuantity,
        bonusQuantity,
        quantity,
        cartonQuantity,
        looseQuantity,
        bonusCartons,
        bonusPieces,
      } = quantityPayload;
      if (quantity <= 0) {
        return res.status(400).json({
          error: "Each item requires sold quantity or bonus greater than zero",
        });
      }
      if (paidQuantity > 0 && unitPrice <= 0) {
        return res.status(400).json({
          error: "Box price must be greater than zero",
        });
      }

      const lineTotal = getLineTotal(paidQuantity, piecesPerCarton, unitPrice);
      subtotal += lineTotal;

      enrichedItems.push({
        productId: new mongoose.Types.ObjectId(productId),
        name: String(name || product.name).trim().slice(0, 120),
        quantity,
        paidQuantity,
        bonusQuantity,
        cartonQuantity,
        looseQuantity,
        bonusCartons,
        bonusPieces,
        piecesPerCarton,
        boxPrice: unitPrice,
        price: unitPrice,
        total: lineTotal,
      });
    }

    const total = subtotal;

    // Confirmed payment history is immutable financial evidence. Reconcile
    // counters from payment events whenever a credit invoice total is edited.
    let reconciledCreditDetails = null;
    if (originalSale.paymentType === "credit") {
      const payments = originalSale.creditDetails?.payments || [];
      const confirmedAmount = Math.round(payments.reduce((sum, payment) =>
        sum + ((!payment.status || payment.status === "confirmed") ? Number(payment.amount || 0) : 0), 0) * 100) / 100;
      const pendingAmount = Math.round(payments.reduce((sum, payment) =>
        sum + (payment.status === "pending" ? Number(payment.amount || 0) : 0), 0) * 100) / 100;
      if (total + 0.001 < confirmedAmount + pendingAmount) {
        return res.status(409).json({
          error: `Le nouveau total ne peut pas être inférieur aux paiements confirmés et en attente (${(confirmedAmount + pendingAmount).toFixed(2)} USD)`,
        });
      }
      reconciledCreditDetails = {
        "creditDetails.amountPaid": confirmedAmount,
        "creditDetails.amountDue": Math.max(0, Math.round((total - confirmedAmount) * 100) / 100),
        "creditDetails.pendingAmount": pendingAmount,
        "creditDetails.fullyPaid": total - confirmedAmount <= 0.009,
      };
    }
    // Calculate stock adjustments
    //do a great job
    const stockAdjustments = [];
    
    for (const newItem of enrichedItems) {
      const oldItem = originalSale.items.find(item => 
        item.productId.toString() === newItem.productId.toString()
      );

      if (oldItem) {
        // Item exists in both old and new - calculate quantity difference
        const quantityDiff = newItem.quantity - oldItem.quantity;
        if (quantityDiff !== 0) {
          stockAdjustments.push({
            productId: newItem.productId,
            adjustment: -quantityDiff // Negative because we're reversing old sale and applying new
          });
        }
      } else {
        // New item added - need to reduce stock
        stockAdjustments.push({
          productId: newItem.productId,
          adjustment: -newItem.quantity
        });
      }
    }

    // Handle removed items - return stock
    for (const oldItem of originalSale.items) {
      const itemStillExists = enrichedItems.find(item => 
        item.productId.toString() === oldItem.productId.toString()
      );
      
      if (!itemStillExists) {
        stockAdjustments.push({
          productId: oldItem.productId,
          adjustment: oldItem.quantity // Positive because we're returning stock
        });
      }
    }

    // Track what changed
    if (JSON.stringify(originalSale.customer) !== JSON.stringify(customer)) {
      changes.set('customer', { from: originalSale.customer, to: customer });
    }
    if (originalSale.total !== total) {
      changes.set('total', { from: originalSale.total, to: total });
    }
    if (originalSale.paymentMethod !== normalizedPM) {
      changes.set('paymentMethod', { from: originalSale.paymentMethod, to: normalizedPM });
    }
    if (originalSale.type !== type) {
      changes.set('type', { from: originalSale.type, to: type });
    }

    // Apply stock adjustments + sale update atomically in a single transaction
    const session = await mongoose.startSession();
    let updatedSale;
    try {
      session.startTransaction();

      const adjustmentMovements = [];
      for (const adjustment of stockAdjustments) {
        const productBefore = await Product.findOne(
          scopedFilter({ _id: adjustment.productId }, req.branchId)
        ).session(session).lean();
        const previousStock = productBefore?.stock || 0;
        const updatedProduct = await adjustBranchStock({
          productId: adjustment.productId,
          branchId: req.branchId,
          delta: adjustment.adjustment,
          requireAvailable: adjustment.adjustment < 0,
          session,
        });
        if (!updatedProduct) {
          await session.abortTransaction();
          await session.endSession();
          return res.status(400).json({ error: "Insufficient stock for product update" });
        }
        adjustmentMovements.push({
          productId: updatedProduct._id,
          productName: updatedProduct.name,
          type: adjustment.adjustment > 0 ? "adjustment_in" : "adjustment_out",
          quantity: Math.abs(adjustment.adjustment),
          piecesPerCarton: updatedProduct.piecesPerCarton || 1,
          reference: originalSale.saleId,
          notes: reason || "Correction de vente",
          recordedBy: req.user.name || req.user.username || "Unknown",
          recordedByUserId: req.user.id,
          recordedByRole: req.user.role,
          branchId: req.branchId,
          previousStock,
          newStock: previousStock + adjustment.adjustment,
        });
      }
      if (adjustmentMovements.length > 0) {
        await StockMovement.create(adjustmentMovements, { session, ordered: true });
      }

      updatedSale = await Sale.findOneAndUpdate(
        scopedFilter({ _id: id }, req.branchId),
        {
          customer,
          items: enrichedItems,
          subtotal,
          total,
          paymentMethod: normalizedPM,
          type: type || originalSale.type,
          reservationDate: reservationDate || originalSale.reservationDate,
          reservationTime: reservationTime || originalSale.reservationTime,
          notes: notes || originalSale.notes,
          ...(reconciledCreditDetails || {}),
          editedBy: req.user.id,
          editedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.id,
              editedAt: new Date(),
              changes: Object.fromEntries(changes),
              reason: reason || "Sale correction"
            }
          }
        },
        { new: true, runValidators: true, session }
      );

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    if (changes.has('customer') || changes.has('total')) {
      await recalculateCustomerStats(originalSale.customerId, req.branchId);
    }

    res.json(updatedSale);
  } catch (error) {
    console.error("Error editing sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    res.status(500).json({ error: "Failed to edit sale" });
  }
});

/** ---------- MARK RESERVATION AS COMPLETED ---------- **/
router.patch("/:id/complete", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
    if (!sale) {
      return res.status(404).json({ error: "Réservation non trouvée" });
    }

    // 🔹 NEW: Check if it's actually a reservation
    if (sale.type !== "reservation") {
      return res.status(400).json({ error: "This is not a reservation" });
    }

    // 🔹 NEW: Check if already completed
    if (sale.status === "completed") {
      return res.status(400).json({ error: "Reservation already completed" });
    }

    const updatedSale = await Sale.findOneAndUpdate(
      scopedFilter({ _id: id }, req.branchId),
      {
        status: "completed",
        completedAt: new Date(),
        completedBy: req.user.username || req.user.id,
      },
      { new: true }
    );

    res.json(updatedSale);
  } catch (error) {
    console.error("Error completing reservation:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** ---------- MARK RESERVATION AS PENDING ---------- **/
router.patch("/:id/pending", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
    if (!sale) {
      return res.status(404).json({ error: "Réservation non trouvée" });
    }

    // 🔹 NEW: RESTRICTION - Only admin can return completed reservations to pending
    if (sale.status === "completed" && !req.user.isSuperAdmin) {
      return res.status(403).json({ 
        error: "Only admin can return completed reservations to pending" 
      });
    }

    // 🔹 NEW: Check if it's actually a reservation
    if (sale.type !== "reservation") {
      return res.status(400).json({ error: "This is not a reservation" });
    }

    const updatedSale = await Sale.findOneAndUpdate(
      scopedFilter({ _id: id }, req.branchId),
      {
        status: "pending",
        completedAt: null,
        completedBy: null,
      },
      { new: true }
    );

    res.json(updatedSale);
  } catch (error) {
    console.error("Error setting reservation to pending:", error);
    res.status(500).json({ error: "Échec de la mise à jour de la réservation" });
  }
});

/** Record and confirm received credit cash atomically. */
router.patch("/:id/credit-payment", authMiddleware, async (req, res) => {
  try {
    const paymentRoles = new Set(["superadmin", "admin", "inventory_manager", "cashier_supervisor"]);
    if (!paymentRoles.has(req.user.role)) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à enregistrer un paiement" });
    }
    const { id } = req.params;
    const { amount, method, notes, paymentDate } = req.body;
    const paymentId = String(
      req.body.paymentId || req.get("Idempotency-Key") || ""
    ).trim();
    const rawPaymentAmount = Number(amount);
    const paymentAmount = Math.round(rawPaymentAmount * 100) / 100;

    if (!Number.isFinite(rawPaymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: "Le montant du paiement doit être positif" });
    }
    if (!paymentId || paymentId.length > 128) {
      return res.status(400).json({ error: "L'identifiant paymentId est requis" });
    }
    const parsedPaymentDate = parsePaymentDate(paymentDate);
    if (!parsedPaymentDate) {
      return res.status(400).json({ error: "La date du paiement est requise au format AAAA-MM-JJ" });
    }
    if (parsedPaymentDate.calendarDate > calendarDateInAccountingZone()) {
      return res.status(400).json({ error: "La date du paiement ne peut pas être dans le futur" });
    }
    if (!mongoose.isObjectIdOrHexString(id)) {
      return res.status(400).json({ error: "Identifiant de vente invalide" });
    }

    const normalizedMethod = normalizePaymentMethod(method || "cash");
    const confirmedAt = new Date();
    const confirmedBy = req.user.username || req.user.id;
    const currentSale = await Sale.findOne(
      scopedFilter({ _id: id }, req.branchId)
    ).lean();

    if (!currentSale) return res.status(404).json({ error: "Vente non trouvée" });
    if (currentSale.paymentType !== "credit") {
      return res.status(400).json({ error: "Cette vente n'est pas à crédit" });
    }
    if (["voided", "corrected", "cancelled", "refunded"].includes(currentSale.status)) {
      return res.status(400).json({ error: "Aucun paiement ne peut être ajouté à cette vente" });
    }

    const existingPayment = currentSale.creditDetails?.payments?.find(
      (payment) => payment.paymentId === paymentId
    );
    if (existingPayment) {
      if (
        Math.abs(Number(existingPayment.amount) - paymentAmount) > 0.001 ||
        existingPayment.method !== normalizedMethod ||
        String(existingPayment.notes || "") !== String(notes || "") ||
        calendarDateInAccountingZone(existingPayment.paymentDate || existingPayment.confirmedAt || existingPayment.date) !== parsedPaymentDate.calendarDate
      ) {
        return res.status(409).json({
          error: "Ce paymentId est déjà utilisé avec des données différentes",
        });
      }
      return res.json({
        success: true,
        idempotent: true,
        message: "Paiement déjà reçu et comptabilisé",
        payment: existingPayment,
        sale: currentSale,
      });
    }

    const confirmedBefore = confirmedAmount(currentSale.creditDetails);
    const pendingBefore = normalizeCreditSaleDocument(currentSale).creditDetails.pendingAmount;
    const currentDue = Math.max(0, Math.round((Number(currentSale.total) - confirmedBefore) * 100) / 100);
    if (paymentAmount > currentDue + 0.001) {
      return res.status(409).json({
        error: `Le paiement dépasse le solde disponible (${currentDue.toFixed(2)} USD)`,
      });
    }

    const currentPaid = Math.max(0, Math.round(confirmedBefore * 100) / 100);
    const remainingDue = Math.max(0, Math.round((currentDue - paymentAmount) * 100) / 100);
    const updatedSale = await Sale.findOneAndUpdate(
      {
        ...scopedFilter({ _id: id }, req.branchId),
        paymentType: "credit",
        status: VALID_REVENUE_STATUS_FILTER,
        "creditDetails.payments.paymentId": { $ne: paymentId },
        // Any competing financial update changes updatedAt, so only one writer
        // can apply counters calculated from this snapshot.
        updatedAt: currentSale.updatedAt,
      },
      {
        $set: {
          "creditDetails.amountPaid": Math.round((currentPaid + paymentAmount) * 100) / 100,
          "creditDetails.amountDue": remainingDue,
          "creditDetails.pendingAmount": pendingBefore,
          "creditDetails.fullyPaid": remainingDue <= 0.009,
        },
        $push: {
          "creditDetails.payments": {
            paymentId, amount: paymentAmount, paymentDate: parsedPaymentDate.value,
            recordedAt: confirmedAt, date: confirmedAt, method: normalizedMethod,
            recordedBy: confirmedBy, notes: notes || "", status: "confirmed",
            confirmedAt, confirmedBy,
          },
        },
      },
      { new: true, runValidators: true }
    );

    if (!updatedSale) {
      const sale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
      if (!sale) return res.status(404).json({ error: "Vente non trouvée" });
      if (sale.paymentType !== "credit") {
        return res.status(400).json({ error: "Cette vente n'est pas à crédit" });
      }
      if (["voided", "corrected", "cancelled", "refunded"].includes(sale.status)) {
        return res.status(400).json({ error: "Aucun paiement ne peut être ajouté à cette vente" });
      }

      const existing = sale.creditDetails?.payments?.find(
        (payment) => payment.paymentId === paymentId
      );
      if (existing) {
        if (
          Math.abs(Number(existing.amount) - paymentAmount) > 0.001 ||
          existing.method !== normalizedMethod ||
          String(existing.notes || "") !== String(notes || "") ||
          calendarDateInAccountingZone(existing.paymentDate || existing.confirmedAt || existing.date) !== parsedPaymentDate.calendarDate
        ) {
          return res.status(409).json({
            error: "Ce paymentId est déjà utilisé avec des données différentes",
          });
        }
        return res.json({
          success: true,
          idempotent: true,
          message: "Paiement déjà reçu et comptabilisé",
          payment: existing,
          sale,
        });
      }

      const available = normalizeCreditSaleDocument(sale).creditDetails.amountDue;
      return res.status(409).json({
        error: `Le paiement dépasse le solde disponible (${available.toFixed(2)} USD)`,
      });
    }

    const payment = updatedSale.creditDetails.payments.find(
      (candidate) => candidate.paymentId === paymentId
    );
    return res.json({
      success: true,
      message: updatedSale.creditDetails.fullyPaid
        ? "Paiement reçu et crédit entièrement soldé"
        : "Paiement reçu et dette mise à jour",
      payment,
      sale: updatedSale,
    });
  } catch (error) {
    console.error("Error recording credit payment:", error);
    return res.status(500).json({ error: "Échec de l'enregistrement du paiement" });
  }
});

/** Atomically acknowledge receipt and move a pending payment into revenue. */
router.patch(
  "/:id/credit-payments/:paymentId/confirm",
  authMiddleware,
  async (req, res) => {
    try {
      const { id, paymentId } = req.params;
      // Keep the authorization decision on the server. Superadmin is explicitly
      // included; branch authority still comes exclusively from authMiddleware
      // and every read/update below remains scoped to req.branchId.
      const confirmationRoles = new Set([
        "superadmin", "admin", "inventory_manager", "cashier_supervisor",
      ]);
      if (!confirmationRoles.has(req.user.role)) {
        return res.status(403).json({ error: "Vous n'êtes pas autorisé à confirmer ce paiement" });
      }
      const sale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
      if (!sale) return res.status(404).json({ error: "Vente non trouvée" });
      if (sale.paymentType !== "credit") {
        return res.status(400).json({ error: "Cette vente n'est pas à crédit" });
      }

      const payment = sale.creditDetails?.payments?.find(
        (candidate) => candidate.paymentId === paymentId
      );
      if (!payment) return res.status(404).json({ error: "Paiement non trouvé" });
      if (!payment.status || payment.status === "confirmed") {
        return res.json({
          success: true,
          idempotent: true,
          message: "La réception est déjà confirmée",
          payment,
          sale,
        });
      }

      const paymentAmount = Number(payment.amount);
      const normalizedBeforeConfirmation = normalizeCreditSaleDocument(sale);
      const confirmedBefore = normalizedBeforeConfirmation.creditDetails.amountPaid;
      const pendingBefore = normalizedBeforeConfirmation.creditDetails.pendingAmount;
      const remainingAfter = Math.max(0, Math.round((Number(sale.total) - confirmedBefore - paymentAmount) * 100) / 100);
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0 || paymentAmount > normalizedBeforeConfirmation.creditDetails.amountDue + 0.001) {
        return res.status(409).json({ error: "Le paiement en attente dépasse le solde disponible" });
      }
      const confirmedAt = new Date();
      const confirmedBy = req.user.username || req.user.id;
      const updatedSale = await Sale.findOneAndUpdate(
        {
          ...scopedFilter({ _id: id }, req.branchId),
          paymentType: "credit",
          status: VALID_REVENUE_STATUS_FILTER,
          updatedAt: sale.updatedAt,
          "creditDetails.payments": {
            $elemMatch: { paymentId, status: "pending", amount: paymentAmount },
          },
        },
        [
          {
            $set: {
              "creditDetails.amountPaid": Math.round((confirmedBefore + paymentAmount) * 100) / 100,
              "creditDetails.amountDue": remainingAfter,
              "creditDetails.pendingAmount": Math.max(0, Math.round((pendingBefore - paymentAmount) * 100) / 100),
              updatedAt: confirmedAt,
              "creditDetails.payments": {
                $map: {
                  input: "$creditDetails.payments",
                  as: "payment",
                  in: {
                    $cond: [
                      { $eq: ["$$payment.paymentId", paymentId] },
                      {
                        $mergeObjects: [
                          "$$payment",
                          { status: "confirmed", confirmedAt, confirmedBy },
                        ],
                      },
                      "$$payment",
                    ],
                  },
                },
              },
            },
          },
          {
            $set: {
              "creditDetails.fullyPaid": {
                $lte: ["$creditDetails.amountDue", 0.009],
              },
            },
          },
        ],
        { new: true }
      );

      if (!updatedSale) {
        const currentSale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
        const currentPayment = currentSale?.creditDetails?.payments?.find(
          (candidate) => candidate.paymentId === paymentId
        );
        if (currentPayment && (!currentPayment.status || currentPayment.status === "confirmed")) {
          return res.json({
            success: true,
            idempotent: true,
            message: "La réception est déjà confirmée",
            payment: currentPayment,
            sale: currentSale,
          });
        }
        return res.status(409).json({
          error: "Le paiement n'a pas pu être confirmé; actualisez la vente",
        });
      }

      const confirmedPayment = updatedSale.creditDetails.payments.find(
        (candidate) => candidate.paymentId === paymentId
      );
      return res.json({
        success: true,
        message: updatedSale.creditDetails.fullyPaid
          ? "Argent reçu et crédit entièrement soldé"
          : "Argent reçu et dette mise à jour",
        payment: confirmedPayment,
        sale: updatedSale,
      });
    } catch (error) {
      console.error("Error confirming credit payment:", error);
      return res.status(500).json({ error: "Échec de la confirmation du paiement" });
    }
  }
);

/** ---------- VOID/REFUND SALE ---------- **/
router.patch("/:id/void", authMiddleware, async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ error: "Only admins can void sales" });
    }

    const { id } = req.params;
    const { reason } = req.body;

    const sale = await Sale.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    if (sale.status === "voided") {
      return res.status(400).json({ error: "Sale is already voided" });
    }

    // Return stock + void sale atomically in a single transaction
    const session = await mongoose.startSession();
    let voidedSale;
    try {
      session.startTransaction();

      if ((sale.type === "sale" || sale.type === "reservation") && sale.items && sale.items.length > 0) {
        const reversalMovements = [];
        for (const item of sale.items) {
          const productBefore = await Product.findOne(
            scopedFilter({ _id: item.productId }, req.branchId)
          ).session(session).lean();
          const previousStock = productBefore?.stock || 0;
          const updatedProduct = await adjustBranchStock({
            productId: item.productId,
            branchId: req.branchId,
            delta: item.quantity,
            session,
          });
          if (updatedProduct) {
            reversalMovements.push({
              productId: item.productId,
              productName: updatedProduct.name,
              type: "adjustment_in",
              quantity: item.quantity,
              piecesPerCarton: updatedProduct.piecesPerCarton || 1,
              reference: sale.saleId,
              notes: reason || "Vente annulée",
              recordedBy: req.user.name || req.user.username || "Unknown",
              recordedByUserId: req.user.id,
              recordedByRole: req.user.role,
              branchId: req.branchId,
              previousStock,
              newStock: previousStock + item.quantity,
            });
          }
        }
        if (reversalMovements.length > 0) {
          await StockMovement.create(reversalMovements, { session, ordered: true });
        }
      }

      voidedSale = await Sale.findOneAndUpdate(
        scopedFilter({ _id: id }, req.branchId),
        {
          status: "voided",
          voidedBy: req.user.id,
          voidedAt: new Date(),
          $push: {
            editHistory: {
              editedBy: req.user.id,
              editedAt: new Date(),
              changes: { status: { from: sale.status, to: "voided" } },
              reason: reason || "Sale voided"
            }
          }
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

    if (sale.customerId && (sale.type === "sale" || sale.type === "reservation")) {
      await recalculateCustomerStats(sale.customerId, req.branchId);
    }

    res.json(voidedSale);
  } catch (error) {
    console.error("Error voiding sale:", error);
    res.status(500).json({ error: "Failed to void sale" });
  }
});

/** ---------- DELETE SALE ---------- **/
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const sale = await Sale.findOne(scopedFilter({ _id: req.params.id }, req.branchId)).lean();
    
    if (!sale) {
      return res.status(404).json({ error: "Sale not found" });
    }

    // 🔹 NEW: RESTRICTION - Only admin can delete reservations
    if (sale.type === "reservation" && !req.user.isSuperAdmin) {
      return res.status(403).json({ 
        error: "Only admin can delete reservations" 
      });
    }

    const customerId = sale.customerId;

    // Return stock + delete sale atomically in a single transaction
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      if ((sale.type === "reservation" || sale.type === "sale") &&
          sale.items && sale.items.length > 0 &&
          sale.status !== "voided") {
        const reversalMovements = [];
        for (const item of sale.items) {
          const productBefore = await Product.findOne(
            scopedFilter({ _id: item.productId }, req.branchId)
          ).session(session).lean();
          const previousStock = productBefore?.stock || 0;
          const updatedProduct = await adjustBranchStock({
            productId: item.productId,
            branchId: req.branchId,
            delta: item.quantity,
            session,
          });
          if (updatedProduct) {
            reversalMovements.push({
              productId: item.productId,
              productName: updatedProduct.name,
              type: "adjustment_in",
              quantity: item.quantity,
              piecesPerCarton: updatedProduct.piecesPerCarton || 1,
              reference: sale.saleId,
              notes: "Vente supprimée",
              recordedBy: req.user.name || req.user.username || "Unknown",
              recordedByUserId: req.user.id,
              recordedByRole: req.user.role,
              branchId: req.branchId,
              previousStock,
              newStock: previousStock + item.quantity,
            });
          }
        }
        if (reversalMovements.length > 0) {
          await StockMovement.create(reversalMovements, { session, ordered: true });
        }
      }

      await Sale.deleteOne(scopedFilter({ _id: req.params.id }, req.branchId)).session(session);

      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      await session.endSession();
    }

    if (customerId && (sale.type === "sale" || sale.type === "reservation")) {
      await recalculateCustomerStats(customerId, req.branchId);
    }

    res.json({
      success: true,
      message: "Sale deleted successfully",
      stockReturned: (sale.type === "reservation" || sale.type === "sale") && sale.items && sale.items.length > 0
    });
  } catch (error) {
    console.error("Error deleting sale:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid sale ID" });
    }
    res.status(500).json({ error: "Failed to delete sale" });
  }
});

module.exports = router;
