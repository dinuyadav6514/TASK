const {
  redisCmd,
  hashPassword,
  verifyPassword,
  createToken,
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

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const action = url.searchParams.get("action") || (url.pathname.split("/").pop());

  try {
    // ------------------------------------------------------------
    // 1. REGISTER
    // ------------------------------------------------------------
    if (action === "register" || action === "signup") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
      }

      const body = parseBody(req);
      const username = (body.username || "").trim();
      const password = (body.password || "").trim();

      if (!username || username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: "Username must be between 3 and 20 characters." });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        return res.status(400).json({ error: "Username can only contain letters, numbers, hyphens, and underscores." });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters long." });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const existing = await redisCmd("GET", userKey);
      if (existing) {
        return res.status(409).json({ error: `Username '${username}' is already taken. Please choose another.` });
      }

      const userId = "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
      const { salt, hash } = hashPassword(password);

      const userRecord = {
        id: userId,
        username,
        salt,
        hash,
        createdAt: new Date().toISOString(),
      };

      await redisCmd("SET", userKey, JSON.stringify(userRecord));

      const token = createToken({ userId, username });
      return res.status(201).json({
        success: true,
        token,
        user: { id: userId, username },
        message: `Registered successfully as ${username}!`,
      });
    }

    // ------------------------------------------------------------
    // 2. LOGIN
    // ------------------------------------------------------------
    if (action === "login" || action === "signin") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
      }

      const body = parseBody(req);
      const username = (body.username || "").trim();
      const password = (body.password || "").trim();

      if (!username || !password) {
        return res.status(400).json({ error: "Please provide both username and password." });
      }

      const userKey = `user:${username.toLowerCase()}`;
      const rawUser = await redisCmd("GET", userKey);
      if (!rawUser) {
        return res.status(401).json({ error: "Invalid username or password." });
      }

      const userRecord = typeof rawUser === "object" ? rawUser : JSON.parse(rawUser);
      const isValid = verifyPassword(password, userRecord.salt, userRecord.hash);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid username or password." });
      }

      const token = createToken({ userId: userRecord.id, username: userRecord.username });
      return res.status(200).json({
        success: true,
        token,
        user: { id: userRecord.id, username: userRecord.username },
        message: `Welcome back, ${userRecord.username}!`,
      });
    }

    // ------------------------------------------------------------
    // 3. ME (SESSION CHECK)
    // ------------------------------------------------------------
    if (action === "me" || action === "verify") {
      const token = extractToken(req);
      if (!token) {
        return res.status(401).json({ error: "No authentication token provided." });
      }

      const payload = verifyToken(token);
      if (!payload) {
        return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
      }

      return res.status(200).json({
        authenticated: true,
        user: { id: payload.userId, username: payload.username },
      });
    }

    // ------------------------------------------------------------
    // 4. CHANGE PASSWORD
    // ------------------------------------------------------------
    if (action === "change-password" || action === "passwd") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
      }

      const token = extractToken(req);
      if (!token) return res.status(401).json({ error: "Authentication required." });
      const payload = verifyToken(token);
      if (!payload || !payload.username) return res.status(401).json({ error: "Session expired or invalid." });

      const body = parseBody(req);
      const oldPassword = (body.oldPassword || "").trim();
      const newPassword = (body.newPassword || "").trim();

      if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: "Please provide both current password and new password." });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: "New password must be at least 6 characters long." });
      }
      if (oldPassword === newPassword) {
        return res.status(400).json({ error: "New password must be different from your current password." });
      }

      const userKey = `user:${payload.username.toLowerCase()}`;
      const rawUser = await redisCmd("GET", userKey);
      if (!rawUser) {
        return res.status(404).json({ error: "User profile not found." });
      }
      const userRecord = typeof rawUser === "object" ? rawUser : JSON.parse(rawUser);
      const isValid = verifyPassword(oldPassword, userRecord.salt, userRecord.hash);
      if (!isValid) {
        return res.status(401).json({ error: "Incorrect current password." });
      }

      const { salt, hash } = hashPassword(newPassword);
      userRecord.salt = salt;
      userRecord.hash = hash;
      userRecord.updatedAt = new Date().toISOString();
      await redisCmd("SET", userKey, JSON.stringify(userRecord));

      return res.status(200).json({
        success: true,
        message: "Password changed successfully! Use your new password next time you log in.",
      });
    }

    // ------------------------------------------------------------
    // 5. CHANGE USERNAME
    // ------------------------------------------------------------
    if (action === "change-username" || action === "rename-user") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
      }

      const token = extractToken(req);
      if (!token) return res.status(401).json({ error: "Authentication required." });
      const payload = verifyToken(token);
      if (!payload || !payload.username) return res.status(401).json({ error: "Session expired or invalid." });

      const body = parseBody(req);
      const newUsername = (body.newUsername || "").trim();
      const password = (body.password || "").trim();

      if (!newUsername || !password) {
        return res.status(400).json({ error: "Please provide both new username and current password." });
      }
      if (newUsername.length < 3 || newUsername.length > 20) {
        return res.status(400).json({ error: "Username must be between 3 and 20 characters." });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(newUsername)) {
        return res.status(400).json({ error: "Username can only contain letters, numbers, hyphens, and underscores." });
      }
      if (newUsername.toLowerCase() === payload.username.toLowerCase()) {
        return res.status(400).json({ error: "New username must be different from current username." });
      }

      const currentKey = `user:${payload.username.toLowerCase()}`;
      const rawUser = await redisCmd("GET", currentKey);
      if (!rawUser) {
        return res.status(404).json({ error: "User profile not found." });
      }
      const userRecord = typeof rawUser === "object" ? rawUser : JSON.parse(rawUser);
      const isValid = verifyPassword(password, userRecord.salt, userRecord.hash);
      if (!isValid) {
        return res.status(401).json({ error: "Incorrect password." });
      }

      const newKey = `user:${newUsername.toLowerCase()}`;
      const conflict = await redisCmd("GET", newKey);
      if (conflict) {
        return res.status(409).json({ error: `Username '${newUsername}' is already taken.` });
      }

      // Update username and migrate key in Redis (user id stays same so tasks are preserved)
      userRecord.username = newUsername;
      userRecord.updatedAt = new Date().toISOString();
      await redisCmd("SET", newKey, JSON.stringify(userRecord));
      await redisCmd("DEL", currentKey);

      const freshToken = createToken({ userId: userRecord.id, username: newUsername });

      return res.status(200).json({
        success: true,
        token: freshToken,
        user: { id: userRecord.id, username: newUsername },
        message: `Username successfully changed from '${payload.username}' to '${newUsername}'!`,
      });
    }

    // ------------------------------------------------------------
    // 6. DELETE ACCOUNT
    // ------------------------------------------------------------
    if (action === "delete-account" || action === "rmuser") {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
      }

      const token = extractToken(req);
      if (!token) return res.status(401).json({ error: "Authentication required." });
      const payload = verifyToken(token);
      if (!payload || !payload.username) return res.status(401).json({ error: "Session expired or invalid." });

      const body = parseBody(req);
      const password = (body.password || "").trim();

      if (!password) {
        return res.status(400).json({ error: "Please enter your password to confirm account deletion." });
      }

      const userKey = `user:${payload.username.toLowerCase()}`;
      const rawUser = await redisCmd("GET", userKey);
      if (!rawUser) {
        return res.status(404).json({ error: "User profile not found." });
      }
      const userRecord = typeof rawUser === "object" ? rawUser : JSON.parse(rawUser);
      const isValid = verifyPassword(password, userRecord.salt, userRecord.hash);
      if (!isValid) {
        return res.status(401).json({ error: "Incorrect password. Deletion aborted." });
      }

      // Permanently remove user and user tasks
      await redisCmd("DEL", userKey);
      await redisCmd("DEL", `tasks:${userRecord.id}`);

      return res.status(200).json({
        success: true,
        message: `Account '${payload.username}' and all associated cloud data have been permanently deleted.`,
      });
    }

    return res.status(400).json({ error: `Unknown auth action: ${action}` });
  } catch (err) {
    if (err.message && err.message.startsWith("DATABASE_NOT_CONFIGURED")) {
      return res.status(503).json({
        error: "Cloud database not connected.",
        details: "Please connect Upstash Redis in your Vercel Project Dashboard (Storage tab) to enable multi-device sync.",
      });
    }
    console.error("Auth API Error:", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
};
