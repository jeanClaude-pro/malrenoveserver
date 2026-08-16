const express = require("express");
const router = express.Router();

const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const { normalizeBranchId } = require("../utils/branchContext");

// Apply auth middleware to all routes
router.use(authMiddleware);

// Get current user profile
router.get("/me", async (req, res) => {
  const userId = req.user._id;
  try {
    const user = await User.findById(userId).select("_id username email role branchId isActive requiresAssignment");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all users (Admin only)
router.get("/", async (req, res) => {
  try {
    // Check if user has permission to manage users
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const users = await User.find().select("_id username email role branchId isActive requiresAssignment createdAt");
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Create new user (Admin only)
router.post("/", async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    let { username, email, password, role, branchId } = req.body;
    username = (username || "").trim();
    email = (email || "").trim().toLowerCase();
    password = String(password || "");

    if (!username || !email || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    // Validate role
    const validRoles = ["admin", "superadmin", "manager", "inventory_manager", "cashier_supervisor", "staff"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const newUser = new User({
      username,
      email,
      password: await bcrypt.hash(password, 10),
      role,
      branchId: normalizeBranchId(branchId),
    });

    await newUser.save();
    
    // Return user without password
    const userResponse = await User.findById(newUser._id).select("_id username email role branchId isActive requiresAssignment");
    res.status(201).json(userResponse);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update user role (Admin only)
router.put("/:userId/role", async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const { role } = req.body;
    const validRoles = ["admin", "superadmin", "manager", "inventory_manager", "cashier_supervisor", "staff"];
    
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { role },
      { new: true }
    ).select("_id username email role branchId isActive requiresAssignment");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Toggle user active status (Admin only)
router.put("/:userId/status", async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.requiresAssignment && user.isActive === false) {
      return res.status(400).json({ message: "Assign a role and branch before activating this account" });
    }
    user.isActive = !user.isActive;
    await user.save();

    res.json({ 
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        branchId: normalizeBranchId(user.branchId),
        isActive: user.isActive,
        requiresAssignment: user.requiresAssignment === true
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put("/:userId/branch", async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }
    const branchId = normalizeBranchId(req.body?.branchId, null);
    if (!branchId) return res.status(400).json({ message: "Invalid branch" });
    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { branchId },
      { new: true, runValidators: true }
    ).select("_id username email role branchId isActive requiresAssignment");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Approve a pending account or update an existing user's complete assignment.
router.put("/:userId/assignment", async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Super Admin required." });
    }
    const validRoles = ["admin", "superadmin", "manager", "inventory_manager", "cashier_supervisor", "staff"];
    const role = String(req.body?.role || "").trim();
    const branchId = normalizeBranchId(req.body?.branchId, null);
    if (!validRoles.includes(role)) return res.status(400).json({ message: "Invalid role" });
    if (!branchId) return res.status(400).json({ message: "Invalid branch" });
    if (req.params.userId === req.user._id.toString() && !["admin", "superadmin"].includes(role)) {
      return res.status(400).json({ message: "You cannot remove your own Super Admin access" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { role, branchId, requiresAssignment: false, isActive: true },
      { new: true, runValidators: true }
    ).select("_id username email role branchId isActive requiresAssignment createdAt");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete user (Admin only)
router.delete("/:userId", async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    // Prevent users from deleting themselves
    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ message: "Cannot delete your own account" });
    }

    const user = await User.findByIdAndDelete(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update user profile (Own profile or Admin)
router.put("/:userId/profile", async (req, res) => {
  try {
    const { username, email } = req.body;
    const userId = req.params.userId;

    // Users can only update their own profile unless they're admin
    if (!req.user.isSuperAdmin && userId !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const updateData = {};
    if (username) updateData.username = username;
    if (email) updateData.email = email;

    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true }
    ).select("_id username email role branchId isActive requiresAssignment");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
