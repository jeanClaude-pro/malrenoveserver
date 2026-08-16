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

function stockPath(branchId) {
  return `branchStock.${normalizeBranchId(branchId)}`;
}

function getBranchStock(product, branchId) {
  if (!product) return 0;
  const id = normalizeBranchId(branchId);
  const stocks = product.branchStock;
  const stored = stocks instanceof Map ? stocks.get(id) : stocks?.[id];
  if (Number.isFinite(Number(stored))) return Number(stored);
  return id === DEFAULT_BRANCH_ID ? Number(product.stock || 0) : 0;
}

function productForBranch(product, branchId) {
  if (!product) return product;
  const value = typeof product.toObject === "function" ? product.toObject() : { ...product };
  value.stock = getBranchStock(value, branchId);
  value.branchId = normalizeBranchId(branchId);
  delete value.branchStock;
  return value;
}

async function ensureBranchStock(productId, branchId, session) {
  const id = normalizeBranchId(branchId);
  const path = stockPath(id);
  let query = Product.findById(productId).select(`stock ${path}`).lean();
  if (session) query = query.session(session);
  const product = await query;
  if (!product) return null;
  const current = getBranchStock(product, id);
  let update = Product.updateOne(
    { _id: productId, [path]: { $exists: false } },
    { $set: { [path]: current } }
  );
  if (session) update = update.session(session);
  await update;
  return current;
}

async function adjustBranchStock({ productId, branchId, delta, session, requireAvailable = false }) {
  const id = normalizeBranchId(branchId);
  const path = stockPath(id);
  await ensureBranchStock(productId, id, session);

  const filter = { _id: productId };
  if (requireAvailable && delta < 0) filter[path] = { $gte: Math.abs(delta) };
  const increments = { [path]: delta };
  // Keep the original field synchronized for old clients and all legacy Butembo data.
  if (id === DEFAULT_BRANCH_ID) increments.stock = delta;

  return Product.findOneAndUpdate(
    filter,
    { $inc: increments },
    { new: true, session }
  );
}

async function setBranchStock({ productId, branchId, value, session, extraUpdates = {} }) {
  const id = normalizeBranchId(branchId);
  const path = stockPath(id);
  const set = { ...extraUpdates, [path]: Math.max(0, Number(value) || 0) };
  if (id === DEFAULT_BRANCH_ID) set.stock = set[path];
  return Product.findByIdAndUpdate(productId, { $set: set }, { new: true, session, runValidators: true });
}

module.exports = {
  BRANCHES,
  DEFAULT_BRANCH_ID,
  normalizeBranchId,
  isSuperAdmin,
  branchScope,
  scopedFilter,
  stockPath,
  getBranchStock,
  productForBranch,
  ensureBranchStock,
  adjustBranchStock,
  setBranchStock,
};
