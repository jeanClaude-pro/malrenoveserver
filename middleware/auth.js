const jwt = require("jsonwebtoken");
const User = require("../models/User");
const {
  BRANCHES,
  DEFAULT_BRANCH_ID,
  normalizeBranchId,
  isSuperAdmin,
} = require("../utils/branchContext");

async function authMiddleware(req, res, next) {
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Use lean() so req.user is a plain JS object — avoids Mongoose document quirks
    const user = await User.findById(decoded.id).select("-password").lean();

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    const userId = user._id.toString();
    const superAdmin = isSuperAdmin(user);
    const assignedBranchId = normalizeBranchId(user.branchId, DEFAULT_BRANCH_ID);
    const requestedHeader = req.header("X-Branch-Id");
    const requestedBranchId = requestedHeader
      ? normalizeBranchId(requestedHeader, null)
      : assignedBranchId;

    if (!requestedBranchId) {
      return res.status(400).json({ message: "Invalid branch" });
    }
    if (!superAdmin && requestedHeader && requestedBranchId !== assignedBranchId) {
      return res.status(403).json({ message: "Access denied for the requested branch" });
    }

    req.branchId = superAdmin ? requestedBranchId : assignedBranchId;
    req.branch = BRANCHES.find((branch) => branch.id === req.branchId);
    req.user = {
      ...user,
      id: userId,
      userId,
      name: user.username,
      branchId: assignedBranchId,
      activeBranchId: req.branchId,
      canValidate: superAdmin || user.role === "manager",
      isAdmin: superAdmin,
      isSuperAdmin: superAdmin,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    res.status(401).json({ message: "Token is not valid" });
  }
}

module.exports = authMiddleware;
