const express = require("express");
const router = express.Router();

const Category = require("../models/Category");

const normalizeCategory = (item) => ({
  name: typeof item?.name === "string" ? item.name.trim() : "",
  description:
    typeof item?.description === "string" ? item.description.trim() : "",
});

// Create a new category
router.post("/", async (req, res) => {
  try {
    const payload = req.body;
    const items = Array.isArray(payload) ? payload : [payload];

    if (items.length === 0) {
      return res.status(400).json({ message: "No categories provided" });
    }

    const normalized = items.map(normalizeCategory);
    const hasInvalid = normalized.some((item) => !item.name);
    if (hasInvalid) {
      return res
        .status(400)
        .json({ message: "Each category must include a valid name" });
    }

    // Upsert avoids duplicate key failures on repeated imports/seeding.
    const bulkOps = normalized.map((item) => ({
      updateOne: {
        filter: { name: item.name },
        update: { $set: { description: item.description } },
        upsert: true,
      },
    }));

    await Category.bulkWrite(bulkOps, { ordered: false });

    const names = normalized.map((item) => item.name);
    const saved = await Category.find({ name: { $in: names } }).sort({
      createdAt: -1,
    });

    res.status(201).json({
      message: "Categories saved successfully",
      count: saved.length,
      categories: saved,
    });
  } catch (error) {
    console.error("Error creating category:", error);
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Failed to create categories" });
  }
});

// Get all categories
router.get("/", async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res.status(200).json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

module.exports = router;
