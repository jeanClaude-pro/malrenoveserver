const test = require("node:test");
const assert = require("node:assert/strict");
const { toTotalPieces, fromTotalPieces } = require("../utils/cartonQuantity");

test("keeps carton-first quantities exact across packaging sizes", () => {
  assert.equal(toTotalPieces(24, 0, 24), 576);
  assert.equal(toTotalPieces(0, 13, 24), 13);
  assert.equal(toTotalPieces(23, 11, 24), 563);
  assert.deepEqual(fromTotalPieces(563, 24), { cartons: 23, loosePieces: 11 });
  assert.deepEqual(fromTotalPieces(37, 12), { cartons: 3, loosePieces: 1 });
});

test("keeps products with different packaging independent", () => {
  const beer = toTotalPieces(2, 3, 24);
  const wine = toTotalPieces(4, 1, 6);
  assert.equal(beer, 51);
  assert.equal(wine, 25);
  assert.equal(beer + wine, 76);
});
