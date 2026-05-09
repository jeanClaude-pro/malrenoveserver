require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const app = express();

// ====== MIDDLEWARE - ORDER MATTERS! ======
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan("combined"));

app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Debug middleware
app.use((req, res, next) => {
  if (req.path.includes("/api/auth/login") || req.path.includes("/api/auth/register")) {
    console.log(`📥 ${req.method} ${req.path}`);
    console.log("  Content-Type:", req.headers['content-type']);
    console.log("  Body:", req.body);
  }
  next();
});

// Env variables - CHECK BOTH NAMES!
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

console.log("=== ENVIRONMENT VARIABLES CHECK ===");
console.log("PORT:", PORT);
console.log("MONGO_URI exists:", !!MONGO_URI);
console.log("MONGO_URI first 20 chars:", MONGO_URI ? MONGO_URI.substring(0, 20) + "..." : "not set");
console.log("NODE_ENV:", process.env.NODE_ENV || "development");
console.log("===================================");

// ====== MONGODB CONNECTION OPTIONS ======
const mongoOptions = {
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  retryReads: true,
  maxPoolSize: 10,
  minPoolSize: 2,
  family: 4, // Force IPv4 - fixes connection issues on Render
};

// ====== MONGODB CONNECTION FUNCTION ======
const connectDB = () => {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI environment variable is not set!");
    return;
  }
  console.log('⏳ Attempting MongoDB connection...');
  mongoose.connect(MONGO_URI, mongoOptions)
    .then(() => {
      console.log("✅ Connected to MongoDB Atlas");
    })
    .catch((err) => {
      console.error("❌ MongoDB connection error:", err.message);
      console.error("⚠️ Retrying in 5 seconds...");
      setTimeout(connectDB, 5000);
    });
};

// ====== MONGODB EVENT HANDLERS ======
mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected successfully');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected. Reconnecting in 5 seconds...');
  setTimeout(connectDB, 5000);
});

// ====== HELPER FUNCTION TO SAFELY LOAD ROUTES ======
const safeRequire = (routePath, routeName) => {
  try {
    const module = require(routePath);
    if (module && typeof module === 'function') {
      return module;
    } else if (module && typeof module === 'object' && module.router) {
      return module.router;
    } else if (module && typeof module === 'object' && typeof module.default === 'function') {
      return module.default;
    } else {
      console.warn(`⚠️  Warning: ${routeName} route at ${routePath} does not export a valid middleware function`);
      return (req, res, next) => next();
    }
  } catch (error) {
    console.error(`❌ Failed to load ${routeName} route:`, error.message);
    // Return a dummy middleware that returns 501 Not Implemented
    return (req, res) => {
      res.status(501).json({ 
        error: `Route ${routeName} not properly configured`,
        details: error.message 
      });
    };
  }
};

// ====== ROUTES - with safe loading ======
console.log("\n=== LOADING ROUTES ===");

// Define route mappings
const routes = [
  { path: "/api/products", name: "products", file: "./routes/products" },
  { path: "/api/sales", name: "sales", file: "./routes/sales" },
  { path: "/api/customers", name: "customers", file: "./routes/customers" },
  { path: "/api/auth", name: "auth", file: "./routes/auth" },
  { path: "/api/users", name: "users", file: "./routes/users" },
  { path: "/api/test", name: "test", file: "./routes/test" },
  { path: "/api/categories", name: "categories", file: "./routes/categories" },
  { path: "/api/print", name: "print", file: "./routes/print" },
  { path: "/api/expenses", name: "expenses", file: "./routes/expenses" },
  { path: "/api/exchange-rates", name: "exchangeRates", file: "./routes/exchangeRates" },
  { path: "/api/entries", name: "entries", file: "./routes/entries" },
  { path: "/api/loan", name: "loan", file: "./routes/loan" },
  { path: "/api/cars", name: "cars", file: "./routes/cars" },
  { path: "/api/car-trips", name: "cars", file: "./routes/cars"}
];

// Load each route
routes.forEach(route => {
  const routeHandler = safeRequire(route.file, route.name);
  app.use(route.path, routeHandler);
  console.log(`✅ Loaded route: ${route.path} -> ${route.file}`);
});

// Health check endpoint
app.get("/health", (req, res) => {
  const dbState = mongoose.connection.readyState;
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };

  res.json({
    status: dbState === 1 ? 'healthy' : 'unhealthy',
    database: states[dbState],
    uptime: process.uptime(),
    timestamp: new Date(),
    mongodb_uri_configured: !!MONGO_URI,
    port: PORT,
    routes_loaded: routes.map(r => r.path)
  });
});

// Serve React frontend in production
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found` });
});

// SPA fallback — all non-API routes return index.html
app.get('/*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  console.error(err.stack);
  res.status(500).json({
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ====== START SERVER ======
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Total routes loaded: ${routes.length}\n`);
});

server.on('error', (err) => {
  console.error('❌ Server failed to start:', err.message);
  process.exit(1);
});

// Connect to MongoDB after server starts
connectDB();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});