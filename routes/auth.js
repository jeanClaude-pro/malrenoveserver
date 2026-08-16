// routes/auth.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const authMiddleware = require("../middleware/auth");
const { BRANCHES, normalizeBranchId } = require("../utils/branchContext");

// Helper: basic field guard
function required(...fields) {
  return fields.every((f) => typeof f === "string" && f.trim().length > 0);
}

// Brute-force protection. Keyed by IP; successful logins don't count against
// the limit so normal staff usage (occasional typos) isn't penalized.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please try again later." },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many registration attempts. Please try again later." },
});

function isBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$/.test(value);
}

router.post("/register", registerLimiter, async (req, res) => {
  try {
    let { username, email, password } = req.body || {};
    username = (username || "").trim();
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(username, email, password)) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      email,
      password: hashedPassword,
      role: "staff",
      branchId: null,
      isActive: false,
      requiresAssignment: true,
    });

    // Keep response minimal for register; client will switch to login
    return res.status(201).json({
      message: `Compte créé pour ${newUser.username}. Un Super Admin doit attribuer le rôle et l'agence avant la première connexion.`,
    });
  } catch (error) {
    console.error("Error registering user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!required(email, password)) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    // 1) DO NOT exclude password here; we need it to compare
    // If your schema had `select: false` for password, you'd use `.select("+password")` instead.
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // 2) Compare plain password with stored hash
    let ok = await bcrypt.compare(password, user.password);

    if (!ok && !isBcryptHash(user.password) && password === user.password) {
      user.password = await bcrypt.hash(password, 10);
      await user.save();
      ok = true;
    }

    if (!ok) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    if (user.requiresAssignment === true) {
      return res.status(403).json({ message: "Compte en attente d'affectation par un Super Admin" });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: "User account is inactive" });
    }

    // 3) Create token AFTER successful compare
    const token = generateToken({ id: user._id });

    // 4) Return a safe user payload (don’t send the password/hash)
    const safeUser = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      role: user.role,
      branchId: normalizeBranchId(user.branchId),
      isSuperAdmin: user.role === "admin" || user.role === "superadmin",
      requiresAssignment: user.requiresAssignment === true,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    // Optional: console.log minimal info (avoid logging tokens in prod)
    console.log("User logged in:", safeUser.id);

    return res.status(200).json({ user: safeUser, token });
  } catch (error) {
    console.error("Error logging in user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/branches", authMiddleware, (req, res) => {
  res.json({
    branches: BRANCHES,
    activeBranchId: req.branchId,
    assignedBranchId: req.user.branchId,
    canSwitchBranch: req.user.isSuperAdmin,
  });
});

module.exports = router;
