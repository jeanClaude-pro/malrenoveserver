// routes/companyReport.js
const express = require("express");
const router = express.Router();
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const authMiddleware = require("../middleware/auth");

// GMT+2 timezone offset used across the POS
const TZ = "+02:00";

// Fetch and compute the full all-time daily rolling balance in one pass.
// Returns every calendar day that has at least one transaction, in date order,
// with openingBalance and closingBalance correctly chained.
async function computeAllDailyBalances() {
  const [salesByDay, entriesByDay, expensesByDay] = await Promise.all([
    // Sales revenue: exclude voided/refunded/cancelled and expense-type records
    Sale.aggregate([
      {
        $match: {
          status: { $nin: ["voided", "cancelled", "refunded"] },
          type: { $ne: "expense" },
        },
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

    // Entries (cash received): active status only
    Entry.aggregate([
      { $match: { status: "active" } },
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
      { $match: { status: "validated" } },
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

  // Merge all three streams into a single map keyed by YYYY-MM-DD
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

  for (const s of salesByDay) {
    const d = ensure(s._id);
    d.salesRevenue = Number(s.salesRevenue) || 0;
    d.salesCount = s.salesCount || 0;
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

// GET /api/company-report/daily-balance?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns the rolling balance chain for the requested display window.
// The opening balance for the first day in the window already accounts for
// every transaction that occurred before that date.
router.get("/daily-balance", authMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;

    const { allDays, currentBalance } = await computeAllDailyBalances();

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
