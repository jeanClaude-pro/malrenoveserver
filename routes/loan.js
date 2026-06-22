const express = require("express");
const router = express.Router();
const Loan = require("../models/Loan");
const authMiddleware = require("../middleware/auth");

function generateLoanId() {
  return `LOAN-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
}

/** ---------- LIST LOANS ---------- **/
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && ["pending", "partial", "paid", "overdue"].includes(status)) {
      filter.status = status;
    }

    const loans = await Loan.find(filter).sort({ createdAt: -1 }).lean();
    res.json(loans);
  } catch (error) {
    console.error("Error fetching loans:", error);
    res.status(500).json({ error: "Failed to fetch loans" });
  }
});

/** ---------- CREATE LOAN ---------- **/
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { borrowerName, borrowerPhone, amount, dueDate, notes } = req.body;

    if (!borrowerName || !borrowerPhone || !amount || !dueDate) {
      return res.status(400).json({
        error: "borrowerName, borrowerPhone, amount, and dueDate are required",
      });
    }

    const loanAmount = parseFloat(amount);
    if (isNaN(loanAmount) || loanAmount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    const loan = new Loan({
      loanId: generateLoanId(),
      borrowerName: String(borrowerName).trim(),
      borrowerPhone: String(borrowerPhone).trim(),
      amount: loanAmount,
      dueDate: new Date(dueDate),
      notes: notes ? String(notes).trim() : "",
      recordedBy: req.user?.id || "Unknown",
    });

    const savedLoan = await loan.save();
    res.status(201).json(savedLoan);
  } catch (error) {
    console.error("Error creating loan:", error);
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    res.status(500).json({ error: "Failed to create loan" });
  }
});

/** ---------- GET LOAN BY ID ---------- **/
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const loan = await Loan.findById(req.params.id);
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }
    res.json(loan);
  } catch (error) {
    console.error("Error fetching loan:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid loan ID" });
    }
    res.status(500).json({ error: "Failed to fetch loan" });
  }
});

/** ---------- RECORD PAYMENT ---------- **/
router.patch("/:id/pay", authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const payment = parseFloat(amount);
    if (isNaN(payment) || payment <= 0) {
      return res.status(400).json({ error: "Payment amount must be a positive number" });
    }

    const loan = await Loan.findById(req.params.id);
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    loan.amountPaid += payment;
    loan.status = loan.amountPaid >= loan.amount ? "paid" : "partial";

    const updatedLoan = await loan.save();
    res.json(updatedLoan);
  } catch (error) {
    console.error("Error recording loan payment:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid loan ID" });
    }
    res.status(500).json({ error: "Failed to record loan payment" });
  }
});

/** ---------- DELETE LOAN ---------- **/
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const loan = await Loan.findByIdAndDelete(req.params.id);
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }
    res.json({ message: "Loan deleted successfully", deletedLoan: { id: loan._id, loanId: loan.loanId } });
  } catch (error) {
    console.error("Error deleting loan:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid loan ID" });
    }
    res.status(500).json({ error: "Failed to delete loan" });
  }
});

module.exports = router;
