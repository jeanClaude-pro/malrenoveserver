const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");

function toPositiveInteger(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** GET /api/stock-movements?productId=xxx&type=loan&from=YYYY-MM-DD&to=YYYY-MM-DD */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { productId, type, loanPaid, from, to } = req.query;

    const filter = {};

    if (productId) {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        return res.status(400).json({ error: "productId invalide" });
      }
      filter.productId = new mongoose.Types.ObjectId(productId);
    }

    if (type) {
      const validTypes = ["loan", "loan_return", "bonus_manual", "adjustment_in", "adjustment_out"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Type invalide. Valeurs: ${validTypes.join(", ")}` });
      }
      filter.type = type;
    }

    if (loanPaid !== undefined) {
      filter.loanPaid = loanPaid === "true";
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const start = new Date(from);
        start.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = start;
      }
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const movements = await StockMovement.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const summary = {
      totalLoans: movements.filter((m) => m.type === "loan").reduce((s, m) => s + m.quantity, 0),
      pendingLoans: movements.filter((m) => m.type === "loan" && !m.loanPaid).length,
      totalBonusManual: movements.filter((m) => m.type === "bonus_manual").reduce((s, m) => s + m.quantity, 0),
      totalAdjustmentsIn: movements.filter((m) => m.type === "adjustment_in").reduce((s, m) => s + m.quantity, 0),
      totalAdjustmentsOut: movements.filter((m) => m.type === "adjustment_out").reduce((s, m) => s + m.quantity, 0),
    };

    res.json({ success: true, data: movements, summary });
  } catch (error) {
    console.error("Error fetching stock movements:", error);
    res.status(500).json({ error: "Échec du chargement des mouvements de stock" });
  }
});

/** POST /api/stock-movements – create a loan, bonus, or adjustment */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      productId,
      type,
      quantity,
      loanCustomer,
      loanCustomerPhone,
      reference,
      notes,
    } = req.body;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ error: "productId invalide ou manquant" });
    }

    const validTypes = ["loan", "bonus_manual", "adjustment_in", "adjustment_out"];
    if (!type || !validTypes.includes(type)) {
      return res.status(400).json({ error: `Type invalide. Valeurs: ${validTypes.join(", ")}` });
    }

    const qty = toPositiveInteger(quantity, 0);
    if (qty <= 0) {
      return res.status(400).json({ error: "La quantité doit être supérieure à zéro" });
    }

    if (type === "loan" && (!loanCustomer || !loanCustomer.trim())) {
      return res.status(400).json({ error: "Le nom du client est requis pour un prêt" });
    }

    const product = await Product.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ error: "Article non trouvé" });
    }
    if (product.status !== "active") {
      return res.status(400).json({ error: "Impossible de créer un mouvement pour un article inactif" });
    }

    // For loan and bonus_manual and adjustment_out, deduct from stock
    const decreasesStock = ["loan", "bonus_manual", "adjustment_out"].includes(type);
    // adjustment_in increases stock

    if (decreasesStock) {
      if (product.stock < qty) {
        return res.status(400).json({
          error: `Stock insuffisant pour "${product.name}". Disponible: ${product.stock}`,
        });
      }
      await Product.findByIdAndUpdate(productId, { $inc: { stock: -qty } });
    } else {
      // adjustment_in
      await Product.findByIdAndUpdate(productId, { $inc: { stock: qty } });
    }

    const movement = new StockMovement({
      productId: new mongoose.Types.ObjectId(productId),
      productName: product.name,
      type,
      quantity: qty,
      piecesPerCarton: product.piecesPerCarton || 1,
      loanCustomer: loanCustomer?.trim() || "",
      loanCustomerPhone: loanCustomerPhone?.trim() || "",
      reference: reference?.trim() || "",
      notes: notes?.trim() || "",
      recordedBy: req.user.username || req.user.userId,
      recordedByUserId: req.user.userId,
    });

    const saved = await movement.save();

    res.status(201).json({ success: true, data: saved });
  } catch (error) {
    console.error("Error creating stock movement:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: messages.join(", ") });
    }
    res.status(500).json({ error: "Échec de la création du mouvement" });
  }
});

/** PATCH /api/stock-movements/:id/mark-loan-paid – mark a loan as paid (stock NOT returned — client keeps goods) */
router.patch("/:id/mark-loan-paid", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const movement = await StockMovement.findById(id).lean();
    if (!movement) {
      return res.status(404).json({ error: "Mouvement non trouvé" });
    }

    if (movement.type !== "loan") {
      return res.status(400).json({ error: "Seuls les prêts peuvent être marqués comme payés" });
    }

    if (movement.loanPaid) {
      return res.status(400).json({ error: "Ce prêt est déjà marqué comme payé" });
    }

    const updated = await StockMovement.findByIdAndUpdate(
      id,
      {
        loanPaid: true,
        loanPaidAt: new Date(),
        loanPaidBy: req.user.username || req.user.userId,
      },
      { new: true }
    );

    res.json({ success: true, data: updated, message: "Prêt marqué comme payé" });
  } catch (error) {
    console.error("Error marking loan as paid:", error);
    res.status(500).json({ error: "Échec de la mise à jour du prêt" });
  }
});

/** DELETE /api/stock-movements/:id – admin only; reverses stock change */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Seuls les administrateurs peuvent supprimer des mouvements" });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const movement = await StockMovement.findById(id).lean();
    if (!movement) {
      return res.status(404).json({ error: "Mouvement non trouvé" });
    }

    // Reverse the stock change
    const decreasedStock = ["loan", "bonus_manual", "adjustment_out"].includes(movement.type);
    if (decreasedStock) {
      await Product.findByIdAndUpdate(movement.productId, { $inc: { stock: movement.quantity } });
    } else {
      await Product.findByIdAndUpdate(movement.productId, {
        $inc: { stock: -movement.quantity },
      });
    }

    await StockMovement.findByIdAndDelete(id);

    res.json({ success: true, message: "Mouvement supprimé et stock corrigé" });
  } catch (error) {
    console.error("Error deleting stock movement:", error);
    res.status(500).json({ error: "Échec de la suppression du mouvement" });
  }
});

module.exports = router;
