const jwt = require("jsonwebtoken");
const User = require("../models/User");
const generateToken = require("../utils/generateToken");
const {
  BRANCHES,
  DEFAULT_BRANCH_ID,
  normalizeBranchId,
  isSuperAdmin,
  canSwitchBranch,
} = require("../utils/branchContext");

// Tokens are minted with a 1-day lifetime (utils/generateToken.js). Rather than
// forcing a hard logout mid-shift, any request made once less than this much of
// that lifetime remains gets silently handed a fresh token (see X-New-Token
// below). A user making at least one request every ~18h therefore never hits
// the hard expiry; someone truly gone for a full day still gets logged out.
const SLIDING_REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

async function authMiddleware(req, res, next) {
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.exp) {
      const remainingMs = decoded.exp * 1000 - Date.now();
      if (remainingMs > 0 && remainingMs < SLIDING_REFRESH_THRESHOLD_MS) {
        res.set("X-New-Token", generateToken({ id: decoded.id }));
      }
    }

    // Use lean() so req.user is a plain JS object — avoids Mongoose document quirks
    const user = await User.findById(decoded.id).select("-password").lean();

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    if (user.requiresAssignment === true || user.isActive === false) {
      return res.status(403).json({ message: "User account is pending assignment or inactive" });
    }

    const userId = user._id.toString();
    const superAdmin = isSuperAdmin(user);
    // Narrower than superAdmin: only this decides whether X-Branch-Id can move
    // the request off the user's assigned branch. Every other authorization
    // flag below (canValidate/isAdmin/isSuperAdmin) stays keyed to superAdmin.
    const canSwitch = canSwitchBranch(user);
    const assignedBranchId = normalizeBranchId(user.branchId, DEFAULT_BRANCH_ID);
    const requestedHeader = req.header("X-Branch-Id");
    const requestedBranchId = requestedHeader
      ? normalizeBranchId(requestedHeader, null)
      : assignedBranchId;

    if (!requestedBranchId) {
      return res.status(400).json({ message: "Invalid branch" });
    }
    if (!canSwitch && requestedHeader && requestedBranchId !== assignedBranchId) {
      return res.status(403).json({ message: "Access denied for the requested branch" });
    }

    req.branchId = canSwitch ? requestedBranchId : assignedBranchId;
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
    const message =
      err.name === "TokenExpiredError" ? "Token expired" : "Token is not valid";
    res.status(401).json({ message });
  }
}

module.exports = authMiddleware;
