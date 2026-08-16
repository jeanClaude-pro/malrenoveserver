const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const {
  BRANCHES,
  scopedFilter,
  getBranchStock,
  adjustBranchStock,
} = require("../utils/branchContext");

function toPositiveInteger(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

// Loans/bonuses/manual adjustments are part of the "Articles & stock" module,
// restricted client-side to manager/inventory_manager (+ super admins). Enforce
// the same rule server-side so it can't be bypassed by calling the API directly.
function canManageStock(user) {
  return Boolean(
    user?.isSuperAdmin ||
      user?.role === "manager" ||
      user?.role === "inventory_manager"
  );
}

const ALL_MOVEMENT_TYPES = [
  "loan",
  "loan_return",
  "bonus_manual",
  "adjustment_in",
  "adjustment_out",
  "car_arrival",
  "transfer_out",
  "sale",
  "reception",
];

// Types that reduce Product.stock — everything else in ALL_MOVEMENT_TYPES increases it.
const DECREASE_TYPES = new Set(["loan", "bonus_manual", "adjustment_out", "transfer_out", "sale"]);

const MOVEMENT_LABELS = {
  loan: "Prêt",
  loan_return: "Retour de prêt",
  bonus_manual: "Bonus manuel",
  adjustment_in: "Ajustement (+)",
  adjustment_out: "Ajustement (-)",
  car_arrival: "Arrivée de camion",
  transfer_out: "Transfert livré",
  sale: "Vente",
  reception: "Réception de transfert",
};

const MOVEMENT_SOURCES = {
  loan: "Prêt",
  loan_return: "Prêt",
  bonus_manual: "Ajustement manuel",
  adjustment_in: "Ajustement manuel",
  adjustment_out: "Ajustement manuel",
  car_arrival: "Camion / Trajet",
  transfer_out: "Transfert",
  sale: "Vente",
  reception: "Transfert",
};

function signedQuantity(movement) {
  return DECREASE_TYPES.has(movement.type) ? -movement.quantity : movement.quantity;
}

// Resolves { start, end } for the Fiche de Stock period selector: today / week / month / custom.
function resolveLedgerPeriod(query) {
  const { range, from, to } = query;
  const now = new Date();

  if (range === "custom" || (!range && (from || to))) {
    if (!from || !to) {
      throw Object.assign(new Error("Les dates 'from' et 'to' sont requises pour une période personnalisée"), { status: 400 });
    }
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw Object.assign(new Error("Format de date invalide"), { status: 400 });
    }
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    if (start > end) {
      throw Object.assign(new Error("La date de début doit précéder la date de fin"), { status: 400 });
    }
    return { start, end, label: "custom" };
  }

  if (range === "week") {
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(now);
    start.setDate(now.getDate() + mondayOffset);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: "week" };
  }

  if (range === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: "month" };
  }

  // Default: today
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end, label: "today" };
}

/**
 * GET /api/stock-movements/ledger/:productId?range=today|week|month|custom&from=&to=
 *
 * The single reliable Fiche de Stock calculation: starting/ending inventory for the
 * period plus the full, period-scoped audit trail. Both the UI and the PDF export
 * must call this endpoint and render its numbers verbatim — never recompute locally.
 */
router.get("/ledger/:productId", authMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ error: "productId invalide" });
    }

    let period;
    try {
      period = resolveLedgerPeriod(req.query);
    } catch (periodError) {
      return res.status(periodError.status || 400).json({ error: periodError.message });
    }

    const product = await Product.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ error: "Article non trouvé" });
    }

    const currentStock = getBranchStock(product, req.branchId);

    // Every movement from the period start onward (no upper bound) — needed to walk
    // both the starting-of-period balance and the ending-of-period balance back from
    // the current, authoritative stock figure.
    const movements = await StockMovement.find(scopedFilter({
      productId,
      createdAt: { $gte: period.start },
    }, req.branchId))
      .sort({ createdAt: 1 })
      .lean();

    let sumFromStart = 0;
    let sumAfterEnd = 0;
    for (const movement of movements) {
      const signed = signedQuantity(movement);
      sumFromStart += signed;
      if (movement.createdAt > period.end) sumAfterEnd += signed;
    }

    const startingStock = currentStock - sumFromStart;
    const endingStock = currentStock - sumAfterEnd;

    let running = startingStock;
    let added = 0;
    let removed = 0;
    const actions = [];
    for (const movement of movements) {
      if (movement.createdAt > period.end) continue;
      const signed = signedQuantity(movement);
      const previousStock = running;
      running += signed;
      if (signed > 0) added += signed;
      else removed += -signed;
      actions.push({
        id: movement._id,
        date: movement.createdAt,
        type: movement.type,
        label: MOVEMENT_LABELS[movement.type] || movement.type,
        source: MOVEMENT_SOURCES[movement.type] || movement.type,
        reference: movement.reference || "",
        previousStock,
        change: signed,
        newStock: running,
        performedBy: movement.recordedBy || "Inconnu",
        performedByRole: movement.recordedByRole || "",
        branchId: req.branchId,
        reason: movement.notes || "",
      });
    }
    actions.reverse(); // most recent first, matching every other history view in the app

    res.json({
      success: true,
      branch: BRANCHES.find((branch) => branch.id === req.branchId),
      product: {
        _id: product._id,
        name: product.name,
        status: product.status,
        category: product.category,
        piecesPerCarton: product.piecesPerCarton || 1,
        currentStock,
      },
      period: {
        range: period.label,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      summary: {
        startingStock,
        added,
        removed,
        endingStock,
        currentStock,
        actionsCount: actions.length,
      },
      actions,
    });
  } catch (error) {
    console.error("Error building stock ledger:", error);
    res.status(500).json({ error: "Échec du calcul de la fiche de stock" });
  }
});

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
      if (!ALL_MOVEMENT_TYPES.includes(type)) {
        return res.status(400).json({ error: `Type invalide. Valeurs: ${ALL_MOVEMENT_TYPES.join(", ")}` });
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

    const movements = await StockMovement.find(scopedFilter(filter, req.branchId))
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
    if (!canManageStock(req.user)) {
      return res.status(403).json({ error: "Accès refusé" });
    }

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

    const previousStock = getBranchStock(product, req.branchId);
    // For loan and bonus_manual and adjustment_out, deduct from stock
    const decreasesStock = ["loan", "bonus_manual", "adjustment_out"].includes(type);
    // adjustment_in increases stock

    if (decreasesStock) {
      if (previousStock < qty) {
        return res.status(400).json({
          error: `Stock insuffisant pour "${product.name}". Disponible: ${previousStock}`,
        });
      }
      const updated = await adjustBranchStock({ productId, branchId: req.branchId, delta: -qty, requireAvailable: true });
      if (!updated) return res.status(409).json({ error: "Le stock a changé; veuillez réessayer" });
    } else {
      // adjustment_in
      await adjustBranchStock({ productId, branchId: req.branchId, delta: qty });
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
      recordedByRole: req.user.role,
      branchId: req.branchId,
      previousStock,
      newStock: previousStock + (decreasesStock ? -qty : qty),
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

    const movement = await StockMovement.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
    if (!movement) {
      return res.status(404).json({ error: "Mouvement non trouvé" });
    }

    if (movement.type !== "loan") {
      return res.status(400).json({ error: "Seuls les prêts peuvent être marqués comme payés" });
    }

    if (movement.loanPaid) {
      return res.status(400).json({ error: "Ce prêt est déjà marqué comme payé" });
    }

    const updated = await StockMovement.findOneAndUpdate(
      scopedFilter({ _id: id }, req.branchId),
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
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ error: "Seuls les administrateurs peuvent supprimer des mouvements" });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const movement = await StockMovement.findOne(scopedFilter({ _id: id }, req.branchId)).lean();
    if (!movement) {
      return res.status(404).json({ error: "Mouvement non trouvé" });
    }

    // Reverse the stock change
    const decreasedStock = ["loan", "bonus_manual", "adjustment_out"].includes(movement.type);
    if (decreasedStock) {
      await adjustBranchStock({ productId: movement.productId, branchId: req.branchId, delta: movement.quantity });
    } else {
      const updated = await adjustBranchStock({ productId: movement.productId, branchId: req.branchId, delta: -movement.quantity, requireAvailable: true });
      if (!updated) return res.status(409).json({ error: "Stock insuffisant pour annuler ce mouvement" });
    }

    await StockMovement.deleteOne(scopedFilter({ _id: id }, req.branchId));

    res.json({ success: true, message: "Mouvement supprimé et stock corrigé" });
  } catch (error) {
    console.error("Error deleting stock movement:", error);
    res.status(500).json({ error: "Échec de la suppression du mouvement" });
  }
});

module.exports = router;
