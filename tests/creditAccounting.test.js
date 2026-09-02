const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calendarDateInAccountingZone,
  normalizeCreditSaleDocument,
  parsePaymentDate,
} = require("../utils/creditAccounting");
const { branchScope, scopedFilter } = require("../utils/branchContext");

test("normalizes unpaid, partial, exact-paid, pending, and legacy credit balances", () => {
  const base = { paymentType: "credit", total: 100 };
  assert.equal(normalizeCreditSaleDocument({ ...base, creditDetails: { payments: [] } }).creditDetails.amountDue, 100);
  const partial = normalizeCreditSaleDocument({ ...base, creditDetails: { payments: [{ amount: 20, status: "confirmed" }] } });
  assert.deepEqual([partial.creditDetails.amountPaid, partial.creditDetails.amountDue, partial.creditDetails.fullyPaid], [20, 80, false]);
  const paid = normalizeCreditSaleDocument({ ...base, creditDetails: { payments: [{ amount: 100, status: "confirmed" }] } });
  assert.deepEqual([paid.creditDetails.amountDue, paid.creditDetails.fullyPaid], [0, true]);
  const pending = normalizeCreditSaleDocument({ ...base, creditDetails: { payments: [{ amount: 25, status: "pending" }] } });
  assert.deepEqual([pending.creditDetails.amountPaid, pending.creditDetails.pendingAmount, pending.creditDetails.amountDue], [0, 25, 100]);
  const legacy = normalizeCreditSaleDocument({ ...base, creditDetails: { amountPaid: 30 } });
  assert.deepEqual([legacy.creditDetails.amountPaid, legacy.creditDetails.amountDue], [30, 70]);
});

test("validates and preserves a GMT+2 accounting calendar date", () => {
  assert.equal(parsePaymentDate("2026-02-30"), null);
  assert.equal(parsePaymentDate("02/09/2026"), null);
  const parsed = parsePaymentDate("2026-08-31");
  assert.ok(parsed);
  assert.equal(calendarDateInAccountingZone(parsed.value), "2026-08-31");
});

test("keeps Beni strict while preserving branch-less legacy records for Butembo", () => {
  assert.deepEqual(branchScope("beni"), { branchId: "beni" });
  assert.deepEqual(branchScope("butembo"), {
    $or: [
      { branchId: "butembo" },
      { branchId: { $exists: false } },
      { branchId: null },
    ],
  });
  assert.deepEqual(scopedFilter({ paymentType: "credit" }, "beni"), {
    $and: [{ paymentType: "credit" }, { branchId: "beni" }],
  });
});
