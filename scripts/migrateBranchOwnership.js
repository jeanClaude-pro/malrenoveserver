// One-off, idempotent backfill for the Product/ExchangeRate branch-isolation fix.
// Run manually after deploying the schema changes, before Beni starts creating
// its own products/rates:
//
//   cd server && node scripts/migrateBranchOwnership.js
//
// Preview what would change without writing anything:
//
//   cd server && node scripts/migrateBranchOwnership.js --dry-run
//
// Safe to run multiple times — every update is guarded to only touch documents
// that have no branch ownership yet, so already-migrated documents (including
// ones already assigned to "beni") are never overwritten, duplicated, or reset.
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const ExchangeRate = require("../models/ExchangeRate");
// Single source of truth for "what does an unassigned record become" — matches
// what every read path (branchScope/scopedFilter) already treats missing/null
// branchId as, so this migration can never disagree with runtime behavior.
const { DEFAULT_BRANCH_ID } = require("../utils/branchContext");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes("--dry-run");

// Matches a document with no real branch ownership yet — either the field was
// never set (legacy pre-multi-branch record), or it was somehow persisted as
// null (bypassing Mongoose's enum validation via a raw driver write). A
// document that already has "butembo" or "beni" is never matched here, so an
// already-migrated or already-Beni-owned record is never touched.
const UNOWNED = { $or: [{ branchId: { $exists: false } }, { branchId: null }] };

async function migrateProducts() {
  const totalBefore = await Product.countDocuments({});
  const missingBranchBefore = await Product.countDocuments(UNOWNED);

  // Legacy shared-catalog products could carry a `branchStock` map with entries
  // for a branch other than butembo. Splitting a single catalog entry into two
  // branch-owned products is a business decision, not something to automate —
  // flag these for manual review instead of guessing.
  const legacyMultiBranch = await Product.find({
    ...UNOWNED,
    $expr: {
      $gt: [
        { $size: { $filter: { input: { $objectToArray: { $ifNull: ["$branchStock", {}] } }, cond: { $ne: ["$$this.k", DEFAULT_BRANCH_ID] } } } },
        0,
      ],
    },
  }).select("_id name branchStock").lean();

  if (legacyMultiBranch.length > 0) {
    console.warn(`⚠️  ${legacyMultiBranch.length} product(s) have legacy non-${DEFAULT_BRANCH_ID} branchStock entries — review manually before/after this migration:`);
    legacyMultiBranch.forEach((p) => console.warn(`   - ${p._id} "${p.name}": ${JSON.stringify(p.branchStock)}`));
  }

  console.log("=== Products ===");
  console.log(`total: ${totalBefore}`);
  console.log(`missing branchId: ${missingBranchBefore}`);
  console.log(`will assign to: ${DEFAULT_BRANCH_ID}`);

  if (DRY_RUN) {
    console.log("No records modified — dry run");
    return;
  }

  const backfillResult = await Product.updateMany(UNOWNED, { $set: { branchId: DEFAULT_BRANCH_ID } });
  // Mongoose's strict mode silently drops updates to paths no longer declared
  // on the schema (branchStock was removed from Product.js), which would make
  // a Model-level $unset here silently no-op — go through the raw driver
  // collection instead so the deprecated field is actually removed.
  const unsetResult = await Product.collection.updateMany({ branchStock: { $exists: true } }, { $unset: { branchStock: "" } });
  const missingBranchAfter = await Product.countDocuments(UNOWNED);

  console.log(`backfilled to ${DEFAULT_BRANCH_ID}: ${backfillResult.modifiedCount}`);
  console.log(`legacy branchStock field removed from: ${unsetResult.modifiedCount}`);
  console.log(`missing branchId after: ${missingBranchAfter}`);
}

async function migrateExchangeRates() {
  const totalBefore = await ExchangeRate.countDocuments({});
  const missingBranchBefore = await ExchangeRate.countDocuments(UNOWNED);

  console.log("=== Exchange rates ===");
  console.log(`total: ${totalBefore}`);
  console.log(`missing branchId: ${missingBranchBefore}`);
  console.log(`will assign to: ${DEFAULT_BRANCH_ID}`);

  if (DRY_RUN) {
    console.log("No records modified — dry run");
    return;
  }

  const backfillResult = await ExchangeRate.updateMany(UNOWNED, { $set: { branchId: DEFAULT_BRANCH_ID } });
  const missingBranchAfter = await ExchangeRate.countDocuments(UNOWNED);

  console.log(`backfilled to ${DEFAULT_BRANCH_ID}: ${backfillResult.modifiedCount}`);
  console.log(`missing branchId after: ${missingBranchAfter}`);
}

async function main() {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI environment variable is not set!");
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI, { family: 4 });
  console.log(`✅ Connected to MongoDB${DRY_RUN ? " (dry run — no writes will be made)" : ""}\n`);

  await migrateProducts();
  console.log("");
  await migrateExchangeRates();

  await mongoose.disconnect();
  console.log(`\n✅ ${DRY_RUN ? "Dry run" : "Migration"} complete.`);
}

main().catch((error) => {
  console.error("❌ Migration failed:", error);
  process.exit(1);
});
