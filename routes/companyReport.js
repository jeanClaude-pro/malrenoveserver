// routes/companyReport.js
const express = require("express");
const router = express.Router();
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Transfer = require("../models/Transfer");
const ExchangeRate = require("../models/ExchangeRate");
const authMiddleware = require("../middleware/auth");
const { scopedFilter, BRANCHES, isSuperAdmin } = require("../utils/branchContext");
const { getGmt2ReportRange } = require("../utils/dateRange");

// GMT+2 timezone offset used across the POS
const TZ = "+02:00";

// Company reports are a "manager"-level module (see client/src/config/access.ts
// — roles: ["manager"], with admin/superadmin always implicitly included).
// access.ts is a client-side convenience only; enforce the same rule here so a
// direct API call from a cashier/inventory role is rejected server-side too.
function canViewCompanyReport(user) {
  return isSuperAdmin(user) || user?.role === "manager";
}

function requireReportAccess(req, res, next) {
  if (!canViewCompanyReport(req.user)) {
    return res.status(403).json({ message: "Accès refusé: rapport réservé aux gérants" });
  }
  next();
}

// Fetch and compute the full all-time daily rolling balance in one pass.
// Returns every calendar day that has at least one transaction, in date order,
// with openingBalance and closingBalance correctly chained.
async function computeAllDailyBalances(branchId) {
  const [cashSalesByDay, creditPaymentsByDay, entriesByDay, expensesByDay] = await Promise.all([
    // Immediate-payment sales enter the report on the sale date.
    Sale.aggregate([
      {
        $match: scopedFilter({
          status: { $nin: ["voided", "corrected", "cancelled", "refunded"] },
          type: { $ne: "expense" },
          paymentType: { $ne: "credit" },
        }, branchId),
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ },
          },
          salesRevenue: { $sum: "$total" },
          salesCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Credit invoices are receivables. Only an explicitly confirmed payment
    // enters cash revenue on its explicit accounting date. Legacy payments
    // fall back to the former confirmedAt/date semantics.
    Sale.aggregate([
      {
        $match: scopedFilter({
          status: { $nin: ["voided", "corrected", "cancelled", "refunded"] },
          type: { $ne: "expense" },
          paymentType: "credit",
        }, branchId),
      },
      { $unwind: "$creditDetails.payments" },
      {
        $match: {
          $or: [
            { "creditDetails.payments.status": "confirmed" },
            { "creditDetails.payments.status": { $exists: false } },
          ],
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: {
                $ifNull: [
                  "$creditDetails.payments.paymentDate",
                  { $ifNull: ["$creditDetails.payments.confirmedAt", "$creditDetails.payments.date"] },
                ],
              },
              timezone: TZ,
            },
          },
          salesRevenue: { $sum: "$creditDetails.payments.amount" },
          salesCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Entries (cash received): active status only
    Entry.aggregate([
      { $match: scopedFilter({ status: "active" }, branchId) },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ },
          },
          entriesAmount: { $sum: "$amount" },
          entriesCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Expenses (cash out): validated status only
    Expense.aggregate([
      { $match: scopedFilter({ status: "validated" }, branchId) },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ },
          },
          expensesAmount: { $sum: "$amount" },
          expensesCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // Merge all transaction streams into a single map keyed by YYYY-MM-DD
  const dayMap = new Map();
  const ensure = (dateStr) => {
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        salesRevenue: 0,
        salesCount: 0,
        entriesAmount: 0,
        entriesCount: 0,
        expensesAmount: 0,
        expensesCount: 0,
      });
    }
    return dayMap.get(dateStr);
  };

  for (const s of [...cashSalesByDay, ...creditPaymentsByDay]) {
    const d = ensure(s._id);
    d.salesRevenue += Number(s.salesRevenue) || 0;
    d.salesCount += s.salesCount || 0;
  }
  for (const e of entriesByDay) {
    const d = ensure(e._id);
    d.entriesAmount = Number(e.entriesAmount) || 0;
    d.entriesCount = e.entriesCount || 0;
  }
  for (const ex of expensesByDay) {
    const d = ensure(ex._id);
    d.expensesAmount = Number(ex.expensesAmount) || 0;
    d.expensesCount = ex.expensesCount || 0;
  }

  // Sort chronologically and compute the running balance chain
  const allDays = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  let runningBalance = 0;
  for (const day of allDays) {
    day.openingBalance = runningBalance;
    const dayNet = day.salesRevenue + day.entriesAmount - day.expensesAmount;
    day.closingBalance = runningBalance + dayNet;
    runningBalance = day.closingBalance;
  }

  return { allDays, currentBalance: runningBalance };
}

// Mirrors customers.js's local customerScope() — legacy customers without a
// `branches` array predate the branch-ownership migration and are treated as
// Butembo, same convention as every other branch-scoped collection.
function customerBranchMatch(branchId) {
  return branchId === "butembo"
    ? { $or: [{ branches: "butembo" }, { branches: { $exists: false } }, { branches: null } ] }
    : { branches: branchId };
}

// Report-oriented, non-paginated summary. MongoDB returns only aggregates;
// history pages remain the place for individual records.
router.get("/summary", authMiddleware, requireReportAccess, async (req, res) => {
  try {
    let range;
    try {
      range = getGmt2ReportRange({ from: req.query.from, to: req.query.to });
    } catch (rangeError) {
      return res.status(400).json({ error: rangeError.message });
    }
    const { start, end } = range; // end is EXCLUSIVE — see utils/dateRange.js
    const period = { createdAt: { $gte: start, $lt: end } };
    const validSales = { status: { $nin: ["voided", "corrected", "cancelled", "refunded"] }, type: { $ne: "expense" } };
    const [cashSales, creditInvoices, creditReceipts, entries, expenses, transferFacets, inventory, customerStatsAgg, rate] = await Promise.all([
      Sale.aggregate([{ $match: scopedFilter({ ...validSales, paymentType: { $ne: "credit" }, ...period }, req.branchId) }, { $group: { _id: null, amount: { $sum: "$total" }, count: { $sum: 1 } } }]),
      Sale.aggregate([
        { $match: scopedFilter({ ...validSales, paymentType: "credit", ...period }, req.branchId) },
        { $set: {
          confirmedPaid: { $cond: [{ $gt: [{ $size: { $ifNull: ["$creditDetails.payments", []] } }, 0] }, { $sum: { $map: { input: "$creditDetails.payments", as: "payment", in: { $cond: [{ $in: [{ $ifNull: ["$$payment.status", "confirmed"] }, ["confirmed"]] }, { $ifNull: ["$$payment.amount", 0] }, 0] } } } }, { $ifNull: ["$creditDetails.amountPaid", 0] }] },
          pendingPaid: { $cond: [{ $gt: [{ $size: { $ifNull: ["$creditDetails.payments", []] } }, 0] }, { $sum: { $map: { input: "$creditDetails.payments", as: "payment", in: { $cond: [{ $eq: ["$$payment.status", "pending"] }, { $ifNull: ["$$payment.amount", 0] }, 0] } } } }, { $ifNull: ["$creditDetails.pendingAmount", 0] }] },
        } },
        { $set: { outstanding: { $max: [0, { $subtract: ["$total", "$confirmedPaid"] }] } } },
        { $group: { _id: null, count: { $sum: 1 }, invoiced: { $sum: "$total" }, paid: { $sum: "$confirmedPaid" }, due: { $sum: "$outstanding" }, pending: { $sum: "$pendingPaid" }, fullyPaid: { $sum: { $cond: [{ $lte: ["$outstanding", 0.009] }, 1, 0] } } } },
      ]),
      Sale.aggregate([
        { $match: scopedFilter({ ...validSales, paymentType: "credit" }, req.branchId) },
        { $unwind: "$creditDetails.payments" },
        { $match: { $or: [{ "creditDetails.payments.status": "confirmed" }, { "creditDetails.payments.status": { $exists: false } }] } },
        { $addFields: { receiptDate: { $ifNull: ["$creditDetails.payments.paymentDate", { $ifNull: ["$creditDetails.payments.confirmedAt", "$creditDetails.payments.date"] }] } } },
        { $match: { receiptDate: { $gte: start, $lt: end } } },
        { $group: { _id: null, amount: { $sum: "$creditDetails.payments.amount" }, count: { $sum: 1 } } },
      ]),
      Entry.aggregate([{ $match: scopedFilter({ status: "active", ...period }, req.branchId) }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Expense.aggregate([{ $match: scopedFilter({ status: "validated", ...period }, req.branchId) }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      // $facet: per-status counts (unchanged) alongside a per-product carton/piece
      // breakdown for the "Informations sur les transferts" table — that table
      // previously read the raw (now paginated) GET /api/transfers list, which
      // would have silently truncated to page 1 for a busy period.
      Transfer.aggregate([
        { $match: scopedFilter(period, req.branchId) },
        {
          $facet: {
            byStatus: [{ $group: { _id: "$status", count: { $sum: 1 }, cartons: { $sum: "$product.cartonQuantity" }, loosePieces: { $sum: "$product.looseQuantity" } } }],
            byProduct: [
              { $match: { status: { $ne: "cancelled" } } },
              { $group: { _id: { $ifNull: ["$product.productId", "$product.name"] }, name: { $last: "$product.name" }, cartonQuantity: { $sum: "$product.cartonQuantity" }, looseQuantity: { $sum: "$product.looseQuantity" } } },
              { $sort: { cartonQuantity: -1 } },
              { $limit: 100 },
            ],
          },
        },
      ]),
      Product.aggregate([{ $match: scopedFilter({}, req.branchId) }, { $group: { _id: null, count: { $sum: 1 }, activeCount: { $sum: { $cond: [{ $ne: ["$status", "inactive"] }, 1, 0] } }, lowStock: { $sum: { $cond: [{ $lte: ["$stock", "$minStock"] }, 1, 0] } }, totalPieces: { $sum: "$stock" } } }]),
      // Branch-scoped purchase stats without loading the customer collection
      // into Node — mirrors customers.js's customerForBranch() field-selection
      // logic (branchStats.<branchId>, falling back to the legacy top-level
      // totalPurchases/totalSpent for Butembo-only pre-migration customers).
      Customer.aggregate([
        { $match: customerBranchMatch(req.branchId) },
        {
          // req.branchId is server-normalized to the literal "butembo"/"beni"
          // (see utils/branchContext.js), so this interpolated dot-path is a
          // safe, version-portable alternative to $getField.
          $addFields: {
            _branchStat: { $ifNull: [`$branchStats.${req.branchId}`, null] },
          },
        },
        {
          $addFields: {
            _totalPurchases: {
              $cond: [
                { $ne: ["$_branchStat", null] },
                "$_branchStat.totalPurchases",
                req.branchId === "butembo" ? { $ifNull: ["$totalPurchases", 0] } : 0,
              ],
            },
            _totalSpent: {
              $cond: [
                { $ne: ["$_branchStat", null] },
                "$_branchStat.totalSpent",
                req.branchId === "butembo" ? { $ifNull: ["$totalSpent", 0] } : 0,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            totalCustomers: { $sum: 1 },
            customersWithPurchases: { $sum: { $cond: [{ $gt: ["$_totalPurchases", 0] }, 1, 0] } },
            totalSpentSum: { $sum: "$_totalSpent" },
          },
        },
      ]),
      ExchangeRate.getCurrentRate(req.branchId),
    ]);
    const cash = cashSales[0] || {};
    const credit = creditInvoices[0] || {};
    const receipts = creditReceipts[0] || {};
    const entry = entries[0] || {};
    const expense = expenses[0] || {};
    const stock = inventory[0] || {};
    const customerStats = customerStatsAgg[0] || { totalCustomers: 0, customersWithPurchases: 0, totalSpentSum: 0 };
    const transferFacetResult = transferFacets[0] || { byStatus: [], byProduct: [] };
    const transferStatusList = transferFacetResult.byStatus || [];
    const transferByStatus = Object.fromEntries(transferStatusList.map((item) => [item._id, item]));
    const revenue = Number(cash.amount || 0) + Number(receipts.amount || 0);
    res.json({
      success: true,
      period: { from: start, to: end },
      branch: BRANCHES.find((branch) => branch.id === req.branchId),
      salesSummary: { revenue, cashSalesRevenue: cash.amount || 0, confirmedCreditPayments: receipts.amount || 0, salesCount: Number(cash.count || 0) + Number(credit.count || 0), creditSalesCount: credit.count || 0, creditTotal: credit.invoiced || 0, creditCollected: credit.paid || 0, creditOutstanding: credit.due || 0, creditPending: credit.pending || 0, creditFullyPaid: credit.fullyPaid || 0 },
      entriesSummary: { active: { amount: entry.amount || 0, count: entry.count || 0 } },
      expensesSummary: { validated: { amount: expense.amount || 0, count: expense.count || 0 } },
      transfersSummary: { total: transferStatusList.reduce((sum, item) => sum + item.count, 0), pending: transferByStatus.pending?.count || 0, inTransit: transferByStatus.in_transit?.count || 0, delivered: transferByStatus.delivered?.count || 0, cancelled: transferByStatus.cancelled?.count || 0, cartons: transferStatusList.reduce((sum, item) => sum + Number(item.cartons || 0), 0), loosePieces: transferStatusList.reduce((sum, item) => sum + Number(item.loosePieces || 0), 0) },
      transfersByProduct: (transferFacetResult.byProduct || []).map((item) => ({ name: item.name || "Article", cartonQuantity: item.cartonQuantity || 0, looseQuantity: item.looseQuantity || 0 })),
      inventorySummary: { productsCount: stock.count || 0, activeCount: stock.activeCount || 0, lowStock: stock.lowStock || 0, totalPieces: stock.totalPieces || 0 },
      customersStats: {
        totalCustomers: customerStats.totalCustomers || 0,
        customersWithPurchases: customerStats.customersWithPurchases || 0,
        averageSpent: customerStats.totalCustomers ? (customerStats.totalSpentSum || 0) / customerStats.totalCustomers : 0,
      },
      exchangeRate: rate ? { rate: rate.rate, effectiveFrom: rate.effectiveFrom } : null,
      netResult: revenue + Number(entry.amount || 0) - Number(expense.amount || 0),
    });
  } catch (error) {
    console.error("Error computing company report summary:", error);
    res.status(500).json({ error: "Failed to compute company report summary" });
  }
});

// GET /api/company-report/daily-balance?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns the rolling balance chain for the requested display window.
// The opening balance for the first day in the window already accounts for
// every transaction that occurred before that date.
router.get("/daily-balance", authMiddleware, requireReportAccess, async (req, res) => {
  try {
    const { from, to } = req.query;

    const { allDays, currentBalance } = await computeAllDailyBalances(req.branchId);

    // Slice to the requested period
    const displayDays = allDays.filter((day) => {
      if (from && day.date < from) return false;
      if (to && day.date > to) return false;
      return true;
    });

    // Period-level summary
    const periodOpeningBalance =
      displayDays.length > 0 ? displayDays[0].openingBalance : currentBalance;
    const periodClosingBalance =
      displayDays.length > 0
        ? displayDays[displayDays.length - 1].closingBalance
        : periodOpeningBalance;

    const periodTotals = displayDays.reduce(
      (acc, day) => ({
        salesRevenue: acc.salesRevenue + day.salesRevenue,
        salesCount: acc.salesCount + day.salesCount,
        entriesAmount: acc.entriesAmount + day.entriesAmount,
        entriesCount: acc.entriesCount + day.entriesCount,
        expensesAmount: acc.expensesAmount + day.expensesAmount,
        expensesCount: acc.expensesCount + day.expensesCount,
      }),
      {
        salesRevenue: 0,
        salesCount: 0,
        entriesAmount: 0,
        entriesCount: 0,
        expensesAmount: 0,
        expensesCount: 0,
      }
    );

    res.json({
      success: true,
      branch: BRANCHES.find((branch) => branch.id === req.branchId),
      days: displayDays,
      periodSummary: {
        openingBalance: periodOpeningBalance,
        closingBalance: periodClosingBalance,
        totalSales: periodTotals.salesRevenue,
        totalEntries: periodTotals.entriesAmount,
        totalExpenses: periodTotals.expensesAmount,
        salesCount: periodTotals.salesCount,
        entriesCount: periodTotals.entriesCount,
        expensesCount: periodTotals.expensesCount,
        netChange: periodClosingBalance - periodOpeningBalance,
      },
      // Overall running balance including every transaction ever recorded
      currentBalance,
    });
  } catch (error) {
    console.error("Error computing daily balance:", error);
    res.status(500).json({ error: "Failed to compute daily balance" });
  }
});

// Sales/reservations count toward "sold quantity" the same way getReceivedRevenue
// (routes/sales.js) treats them as legitimate business events: any status other
// than voided/corrected/cancelled/refunded, restricted to real sale/reservation
// documents (excludes the "expense" type, which never carries items anyway).
// Stock is already deducted when a reservation is CREATED (see POST /api/sales),
// so pending reservations correctly count here too — this mirrors what
// CompanyReport.tsx's default (unfiltered) /api/sales fetch previously included.
const TOP_PRODUCTS_STATUS_FILTER = { $nin: ["voided", "corrected", "cancelled", "refunded"] };
const TOP_PRODUCTS_TYPE_FILTER = { $in: ["sale", "reservation"] };
const DEFAULT_TOP_PRODUCTS_LIMIT = 50;
const MAX_TOP_PRODUCTS_LIMIT = 200;

// GET /api/company-report/top-products?[today|date|month/year|year|from&to]&limit=50
//
// Dedicated aggregation for "Meilleurs articles vendus" / "Produits en bonus".
// Deliberately independent of /api/sales (which is a paginable history
// endpoint) — this reads the full matched period directly from MongoDB so the
// ranking is correct regardless of any pagination applied elsewhere, and
// regardless of whether sibling report sections (customers, expenses, ...)
// succeeded or failed to load on the client.
router.get("/top-products", authMiddleware, requireReportAccess, async (req, res) => {
  try {
    let range;
    try {
      range = getGmt2ReportRange(req.query);
    } catch (rangeError) {
      return res.status(400).json({ error: rangeError.message });
    }

    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_TOP_PRODUCTS_LIMIT)
      : DEFAULT_TOP_PRODUCTS_LIMIT;

    const pipeline = [
      {
        $match: scopedFilter(
          {
            status: TOP_PRODUCTS_STATUS_FILTER,
            type: TOP_PRODUCTS_TYPE_FILTER,
            createdAt: { $gte: range.start, $lt: range.end },
          },
          req.branchId
        ),
      },
      // Oldest-first so $last below picks the most recent name/piecesPerCarton
      // snapshot for a product that was renamed or repackaged mid-period.
      { $sort: { createdAt: 1 } },
      { $unwind: "$items" },
      {
        $addFields: {
          "items._piecesPerCarton": { $ifNull: ["$items.piecesPerCarton", 1] },
          "items._bonusQuantity": { $ifNull: ["$items.bonusQuantity", 0] },
        },
      },
      {
        $addFields: {
          // Legacy items saved before paidQuantity existed only stored a
          // combined `quantity` (paid + bonus) — recover paid-only by
          // subtracting the (already-defaulted) bonus quantity from it.
          "items._paidQuantity": {
            $ifNull: [
              "$items.paidQuantity",
              { $max: [0, { $subtract: [{ $ifNull: ["$items.quantity", 0] }, "$items._bonusQuantity"] }] },
            ],
          },
          "items._hasPaidParts": {
            $gt: [{ $add: [{ $ifNull: ["$items.cartonQuantity", 0] }, { $ifNull: ["$items.looseQuantity", 0] }] }, 0],
          },
          "items._hasBonusParts": {
            $gt: [{ $add: [{ $ifNull: ["$items.bonusCartons", 0] }, { $ifNull: ["$items.bonusPieces", 0] }] }, 0],
          },
        },
      },
      {
        $addFields: {
          "items._soldCartons": {
            $cond: [
              "$items._hasPaidParts",
              { $ifNull: ["$items.cartonQuantity", 0] },
              { $floor: { $divide: ["$items._paidQuantity", "$items._piecesPerCarton"] } },
            ],
          },
          "items._soldPieces": {
            $cond: [
              "$items._hasPaidParts",
              { $ifNull: ["$items.looseQuantity", 0] },
              { $mod: ["$items._paidQuantity", "$items._piecesPerCarton"] },
            ],
          },
          "items._bonusCartons": {
            $cond: [
              "$items._hasBonusParts",
              { $ifNull: ["$items.bonusCartons", 0] },
              { $floor: { $divide: ["$items._bonusQuantity", "$items._piecesPerCarton"] } },
            ],
          },
          "items._bonusPieces": {
            $cond: [
              "$items._hasBonusParts",
              { $ifNull: ["$items.bonusPieces", 0] },
              { $mod: ["$items._bonusQuantity", "$items._piecesPerCarton"] },
            ],
          },
          // Credit invoices are receivables, not recognized cash — never
          // attribute their invoice value to product "revenue" here (see the
          // official financial equation; confirmed credit payments are
          // tracked separately in /daily-balance, not per-product).
          "items._revenue": {
            $cond: [
              { $eq: ["$paymentType", "credit"] },
              0,
              {
                $ifNull: [
                  "$items.total",
                  {
                    $multiply: [
                      { $ifNull: ["$items.price", 0] },
                      { $divide: ["$items._paidQuantity", "$items._piecesPerCarton"] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: { $ifNull: ["$items.productId", { $concat: ["name:", { $ifNull: ["$items.name", "Article"] }] }] },
          productId: { $last: "$items.productId" },
          name: { $last: { $ifNull: ["$items.name", "Article"] } },
          piecesPerCarton: { $last: "$items._piecesPerCarton" },
          paidQuantity: { $sum: "$items._paidQuantity" },
          bonusQuantity: { $sum: "$items._bonusQuantity" },
          soldCartons: { $sum: "$items._soldCartons" },
          soldPieces: { $sum: "$items._soldPieces" },
          bonusCartons: { $sum: "$items._bonusCartons" },
          bonusPieces: { $sum: "$items._bonusPieces" },
          revenue: { $sum: "$items._revenue" },
        },
      },
      // Historical safety: a deactivated/renamed product still resolves by
      // _id, so its current stock is still shown; a product that no longer
      // exists at all (never expected, but tolerated) just shows stock 0.
      {
        $lookup: {
          from: "products",
          localField: "productId",
          foreignField: "_id",
          as: "_product",
        },
      },
      {
        $addFields: {
          remainingStock: { $ifNull: [{ $arrayElemAt: ["$_product.stock", 0] }, 0] },
          productActive: { $ne: [{ $arrayElemAt: ["$_product.status", 0] }, "inactive"] },
        },
      },
      {
        $project: {
          _id: 0,
          productId: 1,
          name: 1,
          piecesPerCarton: 1,
          paidQuantity: 1,
          bonusQuantity: 1,
          soldCartons: 1,
          soldPieces: 1,
          bonusCartons: 1,
          bonusPieces: 1,
          revenue: 1,
          remainingStock: 1,
          productActive: 1,
        },
      },
      {
        $facet: {
          topByQuantity: [{ $sort: { paidQuantity: -1, name: 1 } }, { $limit: limit }],
          topByBonus: [
            { $match: { bonusQuantity: { $gt: 0 } } },
            { $sort: { bonusQuantity: -1, name: 1 } },
            { $limit: limit },
          ],
          totals: [
            {
              $group: {
                _id: null,
                distinctProducts: { $sum: 1 },
                totalPaidQuantity: { $sum: "$paidQuantity" },
                totalBonusQuantity: { $sum: "$bonusQuantity" },
                totalRevenue: { $sum: "$revenue" },
              },
            },
          ],
        },
      },
    ];

    const [result] = await Sale.aggregate(pipeline);
    const totals = result.totals[0] || {
      distinctProducts: 0,
      totalPaidQuantity: 0,
      totalBonusQuantity: 0,
      totalRevenue: 0,
    };

    res.json({
      success: true,
      branch: BRANCHES.find((branch) => branch.id === req.branchId),
      period: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        description: range.description,
      },
      topByQuantity: result.topByQuantity,
      topByBonus: result.topByBonus,
      totals,
    });
  } catch (error) {
    console.error("Error computing top products:", error);
    res.status(500).json({ error: "Failed to compute top products" });
  }
});

module.exports = router;
