const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function toPositiveInteger(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function sanitizeText(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function buildStockPayload(body, existingProduct = null) {
  const piecesPerCarton = toPositiveInteger(
    body.piecesPerCarton,
    existingProduct?.piecesPerCarton || 1
  );
  const cartonStock = toNonNegativeInteger(body.cartonStock, 0);
  const loosePieces = toNonNegativeInteger(body.loosePieces, 0);

  if (loosePieces >= piecesPerCarton) {
    return {
      error: `Les pièces restantes doivent être inférieures à ${piecesPerCarton}`,
    };
  }

  const stock =
    body.cartonStock !== undefined || body.loosePieces !== undefined
      ? cartonStock * piecesPerCarton + loosePieces
      : body.stock !== undefined
      ? toNonNegativeInteger(body.stock, 0)
      : toNonNegativeInteger(existingProduct?.stock, 0);

  const minStock =
    body.minStockCartons !== undefined || body.minStockPieces !== undefined
      ? toNonNegativeInteger(body.minStockCartons, 0) * piecesPerCarton +
        toNonNegativeInteger(body.minStockPieces, 0)
      : body.minStock !== undefined
      ? toNonNegativeInteger(body.minStock, 0)
      : toNonNegativeInteger(existingProduct?.minStock, 0);

  return { stock, minStock, piecesPerCarton };
}

// GET /api/products - Get all products with optional filtering
router.get("/", authMiddleware, async (req, res) => {
  console.log("Fetching products with filters:", req.query);
  try {
    const { search, category, status } = req.query;

    // Build filter object
    const filter = {};

    if (search) {
      filter.$text = { $search: sanitizeText(search, 80) };
    }

    if (category) {
      filter.category = sanitizeText(category, 80);
    }

    if (status && ["active", "inactive"].includes(status)) {
      filter.status = status;
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /api/products/:id - Get a single product by ID
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    console.error("Error fetching product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// POST /api/products - Create a new product
router.post("/", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      stock,
      minStock,
      piecesPerCarton,
      cartonStock,
      loosePieces,
      minStockCartons,
      minStockPieces,
      unit,
      weight,
      status,
    } = req.body;

    const safeName = sanitizeText(name);
    const safeCategory = sanitizeText(category, 80);
    const safeStatus = ["active", "inactive"].includes(status) ? status : "active";

    // Validate required fields
    if (!safeName || !safeCategory) {
      return res.status(400).json({
        error: "Name and category are required fields",
      });
    }

    const stockPayload = buildStockPayload({
      stock,
      minStock,
      piecesPerCarton,
      cartonStock,
      loosePieces,
      minStockCartons,
      minStockPieces,
    });

    if (stockPayload.error) {
      return res.status(400).json({ error: stockPayload.error });
    }

    const product = new Product({
      name: safeName,
      description: sanitizeText(description, 500),
      category: safeCategory,
      brand: sanitizeText(brand, 80),
      stock: stockPayload.stock,
      minStock: stockPayload.minStock,
      piecesPerCarton: stockPayload.piecesPerCarton,
      unit: sanitizeText(unit, 30) || "pièce",
      weight: Math.max(0, Number(weight) || 0),
      status: safeStatus,
    });

    const savedProduct = await product.save();
    res.status(201).json(savedProduct);
  } catch (error) {
    console.error("Error creating product:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    res.status(500).json({ error: "Failed to create product" });
  }
});

// PUT /api/products/:id - Update a product
router.put("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      stock,
      minStock,
      piecesPerCarton,
      cartonStock,
      loosePieces,
      minStockCartons,
      minStockPieces,
      unit,
      weight,
      status,
    } = req.body;

    const existingProduct = await Product.findById(req.params.id);
    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Build update object with only provided fields
    const updateData = {};

    if (name !== undefined) {
      const safeName = sanitizeText(name);
      if (!safeName) return res.status(400).json({ error: "Name is required" });
      updateData.name = safeName;
    }
    if (description !== undefined) updateData.description = sanitizeText(description, 500);
    if (category !== undefined) {
      const safeCategory = sanitizeText(category, 80);
      if (!safeCategory) return res.status(400).json({ error: "Category is required" });
      updateData.category = safeCategory;
    }
    if (brand !== undefined) updateData.brand = sanitizeText(brand, 80);
    if (
      stock !== undefined ||
      minStock !== undefined ||
      piecesPerCarton !== undefined ||
      cartonStock !== undefined ||
      loosePieces !== undefined ||
      minStockCartons !== undefined ||
      minStockPieces !== undefined
    ) {
      const stockPayload = buildStockPayload({
        stock,
        minStock,
        piecesPerCarton,
        cartonStock,
        loosePieces,
        minStockCartons,
        minStockPieces,
      }, existingProduct);

      if (stockPayload.error) {
        return res.status(400).json({ error: stockPayload.error });
      }

      updateData.stock = stockPayload.stock;
      updateData.minStock = stockPayload.minStock;
      updateData.piecesPerCarton = stockPayload.piecesPerCarton;
    }
    if (unit !== undefined) updateData.unit = sanitizeText(unit, 30) || "piÃ¨ce";
    if (weight !== undefined) updateData.weight = Math.max(0, Number(weight) || 0);
    if (status !== undefined) {
      if (!["active", "inactive"].includes(status)) {
        return res.status(400).json({ error: "Invalid product status" });
      }
      updateData.status = status;
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(updatedProduct);
  } catch (error) {
    console.error("Error updating product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE /api/products/:id - Delete a product
router.delete("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const deletedProduct = await Product.findByIdAndDelete(req.params.id);

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to delete product" });
  }
});

// POST /api/products/:id/sell - Special endpoint for selling products
router.post("/:id/sell", authMiddleware, async (req, res) => {
  try {
    // Find the product
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Check if product is active
    if (product.status !== "active") {
      return res.status(400).json({ 
        error: "Cannot sell inactive product" 
      });
    }

    const piecesPerCarton = toPositiveInteger(product.piecesPerCarton, 1);
    const boxQuantity = toNonNegativeInteger(req.body.boxQuantity ?? req.body.cartonQuantity, 0);
    const loosePieces = toNonNegativeInteger(req.body.loosePieces ?? req.body.pieces, 0);
    if (loosePieces >= piecesPerCarton) {
      return res.status(400).json({
        error: `Les piÃ¨ces doivent Ãªtre infÃ©rieures Ã  ${piecesPerCarton}`,
      });
    }
    const quantity =
      boxQuantity > 0 || loosePieces > 0
        ? boxQuantity * piecesPerCarton + loosePieces
        : toPositiveInteger(req.body.quantity, 1);

    // Check stock availability
    if (product.stock < quantity) {
      return res.status(400).json({ 
        error: `Stock insuffisant. Disponible: ${product.stock} pièce(s)` 
      });
    }

    // Update stock (reduce by quantity sold)
    product.stock -= quantity;
    await product.save();

    // Return success response with sale details
    res.json({
      message: "Product sold successfully",
      saleDetails: {
        productId: product._id,
        productName: product.name,
        quantity: quantity,
        remainingStock: product.stock
      }
    });

  } catch (error) {
    console.error("Error selling product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to process sale" });
  }
});

module.exports = router;
