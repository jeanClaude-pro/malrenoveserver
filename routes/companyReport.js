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
const { scopedFilter, BRANCHES } = require("../utils/branchContext");

// GMT+2 timezone offset used across the POS
const TZ = "+02:00";

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
    // enters cash revenue, on its confirmation date (not the invoice date).
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
                  "$creditDetails.payments.confirmedAt",
                  "$creditDetails.payments.date",
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

// Report-oriented, non-paginated summary. MongoDB returns only aggregates;
// history pages remain the place for individual records.
router.get("/summary", authMiddleware, async (req, res) => {
  try {
    const start = req.query.from ? new Date(`${req.query.from}T00:00:00`) : new Date(0);
    const end = req.query.to ? new Date(`${req.query.to}T23:59:59.999`) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return res.status(400).json({ error: "Invalid report period" });
    }
    const period = { createdAt: { $gte: start, $lte: end } };
    const validSales = { status: { $nin: ["voided", "corrected", "cancelled", "refunded"] }, type: { $ne: "expense" } };
    const [cashSales, creditInvoices, creditReceipts, entries, expenses, transfers, inventory, customerCount, rate] = await Promise.all([
      Sale.aggregate([{ $match: scopedFilter({ ...validSales, paymentType: { $ne: "credit" }, ...period }, req.branchId) }, { $group: { _id: null, amount: { $sum: "$total" }, count: { $sum: 1 } } }]),
      Sale.aggregate([{ $match: scopedFilter({ ...validSales, paymentType: "credit", ...period }, req.branchId) }, { $group: { _id: null, count: { $sum: 1 }, invoiced: { $sum: "$total" }, paid: { $sum: { $ifNull: ["$creditDetails.amountPaid", 0] } }, due: { $sum: { $ifNull: ["$creditDetails.amountDue", "$total"] } }, pending: { $sum: { $ifNull: ["$creditDetails.pendingAmount", 0] } }, fullyPaid: { $sum: { $cond: ["$creditDetails.fullyPaid", 1, 0] } } } }]),
      Sale.aggregate([
        { $match: scopedFilter({ ...validSales, paymentType: "credit" }, req.branchId) },
        { $unwind: "$creditDetails.payments" },
        { $match: { $or: [{ "creditDetails.payments.status": "confirmed" }, { "creditDetails.payments.status": { $exists: false } }] } },
        { $addFields: { receiptDate: { $ifNull: ["$creditDetails.payments.confirmedAt", "$creditDetails.payments.date"] } } },
        { $match: { receiptDate: { $gte: start, $lte: end } } },
        { $group: { _id: null, amount: { $sum: "$creditDetails.payments.amount" }, count: { $sum: 1 } } },
      ]),
      Entry.aggregate([{ $match: scopedFilter({ status: "active", ...period }, req.branchId) }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Expense.aggregate([{ $match: scopedFilter({ status: "validated", ...period }, req.branchId) }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Transfer.aggregate([{ $match: scopedFilter(period, req.branchId) }, { $group: { _id: "$status", count: { $sum: 1 }, cartons: { $sum: "$product.cartonQuantity" }, loosePieces: { $sum: "$product.looseQuantity" } } }]),
      Product.aggregate([{ $match: scopedFilter({}, req.branchId) }, { $group: { _id: null, count: { $sum: 1 }, lowStock: { $sum: { $cond: [{ $lte: ["$stock", "$minStock"] }, 1, 0] } }, totalPieces: { $sum: "$stock" } } }]),
      Customer.countDocuments({ $or: [{ branches: req.branchId }, ...(req.branchId === "butembo" ? [{ branches: { $exists: false } }, { branches: null }] : [])] }),
      ExchangeRate.getCurrentRate(req.branchId),
    ]);
    const cash = cashSales[0] || {};
    const credit = creditInvoices[0] || {};
    const receipts = creditReceipts[0] || {};
    const entry = entries[0] || {};
    const expense = expenses[0] || {};
    const stock = inventory[0] || {};
    const transferSummary = Object.fromEntries(transfers.map((item) => [item._id, item]));
    const revenue = Number(cash.amount || 0) + Number(receipts.amount || 0);
    res.json({
      success: true,
      period: { from: start, to: end },
      branch: BRANCHES.find((branch) => branch.id === req.branchId),
      salesSummary: { revenue, cashSalesRevenue: cash.amount || 0, confirmedCreditPayments: receipts.amount || 0, salesCount: Number(cash.count || 0) + Number(credit.count || 0), creditSalesCount: credit.count || 0, creditTotal: credit.invoiced || 0, creditCollected: credit.paid || 0, creditOutstanding: credit.due || 0, creditPending: credit.pending || 0, creditFullyPaid: credit.fullyPaid || 0 },
      entriesSummary: { active: { amount: entry.amount || 0, count: entry.count || 0 } },
      expensesSummary: { validated: { amount: expense.amount || 0, count: expense.count || 0 } },
      transfersSummary: { total: transfers.reduce((sum, item) => sum + item.count, 0), pending: transferSummary.pending?.count || 0, inTransit: transferSummary.in_transit?.count || 0, delivered: transferSummary.delivered?.count || 0, cancelled: transferSummary.cancelled?.count || 0, cartons: transfers.reduce((sum, item) => sum + Number(item.cartons || 0), 0), loosePieces: transfers.reduce((sum, item) => sum + Number(item.loosePieces || 0), 0) },
      inventorySummary: { productsCount: stock.count || 0, lowStock: stock.lowStock || 0, totalPieces: stock.totalPieces || 0 },
      customersStats: { totalCustomers: customerCount },
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
router.get("/daily-balance", authMiddleware, async (req, res) => {
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

module.exports = router;
