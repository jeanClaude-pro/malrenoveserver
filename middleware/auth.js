const jwt = require("jsonwebtoken");
const User = require("../models/User");

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
    req.user = {
      ...user,
      id: userId,
      userId,
      name: user.username,
      canValidate: user.role === "admin" || user.role === "manager",
      isAdmin: user.role === "admin",
    };

    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    res.status(401).json({ message: "Token is not valid" });
  }
}

module.exports = authMiddleware;