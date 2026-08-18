const Product = require("../models/Product");

const BRANCHES = Object.freeze([
  Object.freeze({ id: "butembo", name: "Butembo" }),
  Object.freeze({ id: "beni", name: "Beni" }),
]);
const BRANCH_IDS = new Set(BRANCHES.map((branch) => branch.id));
const DEFAULT_BRANCH_ID = "butembo";

function normalizeBranchId(value, fallback = DEFAULT_BRANCH_ID) {
  const normalized = String(value || "").trim().toLowerCase();
  return BRANCH_IDS.has(normalized) ? normalized : fallback;
}

function isSuperAdmin(user) {
  return user?.role === "admin" || user?.role === "superadmin";
}

function branchScope(branchId, field = "branchId") {
  const id = normalizeBranchId(branchId);
  if (id !== DEFAULT_BRANCH_ID) return { [field]: id };
  return {
    $or: [
      { [field]: id },
      { [field]: { $exists: false } },
      { [field]: null },
    ],
  };
}

function scopedFilter(filter, branchId, field = "branchId") {
  const base = filter && Object.keys(filter).length ? filter : {};
  return { $and: [base, branchScope(branchId, field)] };
}

// Atomically adjusts a product's stock, scoped to the branch it belongs to.
// `requireAvailable` guards a negative delta with a $gte check so concurrent
// requests can never drive stock below zero.
async function adjustBranchStock({ productId, branchId, delta, session, requireAvailable = false }) {
  const id = normalizeBranchId(branchId);
  const productFilter = { _id: productId };
  if (requireAvailable && delta < 0) productFilter.stock = { $gte: Math.abs(delta) };
  // scopedFilter (not a plain branchId equality) so a legacy product that
  // predates the branch-ownership migration — still matched by every read
  // path via branchScope's missing/null fallback — isn't invisible to writes
  // too, which would otherwise surface as a false "stock changed" conflict.
  let query = Product.findOneAndUpdate(scopedFilter(productFilter, id), { $inc: { stock: delta } }, { new: true });
  if (session) query = query.session(session);
  return query;
}

module.exports = {
  BRANCHES,
  DEFAULT_BRANCH_ID,
  normalizeBranchId,
  isSuperAdmin,
  branchScope,
  scopedFilter,
  adjustBranchStock,
};
