const {
  redisCmd,
  verifyToken,
  extractToken,
} = require("./lib/db");

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch (err) {
    return {};
  }
}

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 1. Authenticate user from bearer token
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Authentication required",
      details: "Please log in using 'login <username> <password>' or register using 'register <username> <password>'.",
    });
  }

  const payload = verifyToken(token);
  if (!payload || !payload.userId) {
    return res.status(401).json({
      error: "Session expired or invalid",
      details: "Please log in again.",
    });
  }

  const tasksKey = `tasks:${payload.userId}`;

  try {
    // ------------------------------------------------------------
    // GET: Retrieve user's synced tasks
    // ------------------------------------------------------------
    if (req.method === "GET") {
      const raw = await redisCmd("GET", tasksKey);
      if (!raw) {
        // Return starter template for brand-new users
        return res.status(200).json({
          tasks: [],
          categories: ["general"],
          meta: { version: 2 },
          isNew: true,
          updatedAt: new Date().toISOString(),
        });
      }

      const data = typeof raw === "object" ? raw : JSON.parse(raw);
      return res.status(200).json({
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        categories: Array.isArray(data.categories) ? data.categories : ["general"],
        meta: data.meta || { version: 2 },
        updatedAt: data.updatedAt || new Date().toISOString(),
      });
    }

    // ------------------------------------------------------------
    // POST: Save user's synced tasks
    // ------------------------------------------------------------
    if (req.method === "POST") {
      const body = parseBody(req);
      if (!body || !Array.isArray(body.tasks)) {
        return res.status(400).json({ error: "Invalid payload: 'tasks' array is required." });
      }

      const tasksPayload = {
        tasks: body.tasks,
        categories: Array.isArray(body.categories) ? body.categories : ["general"],
        meta: body.meta || { version: 2 },
        updatedAt: new Date().toISOString(),
      };

      await redisCmd("SET", tasksKey, JSON.stringify(tasksPayload));

      return res.status(200).json({
        success: true,
        count: tasksPayload.tasks.length,
        updatedAt: tasksPayload.updatedAt,
      });
    }

    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  } catch (err) {
    if (err.message && err.message.startsWith("DATABASE_NOT_CONFIGURED")) {
      return res.status(503).json({
        error: "Cloud database not connected.",
        details: "Please connect Upstash Redis in your Vercel Project Dashboard (Storage tab) to enable multi-device sync.",
      });
    }
    console.error("Tasks API Error:", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
};
