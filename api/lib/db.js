const crypto = require("crypto");

const SECRET = process.env.AUTH_SECRET || "task-terminal-secret-key-default-v1";

// Memory store fallback for local tests or when cloud DB is not yet connected
const memoryStore = new Map();

/**
 * Execute a Redis command against Upstash / Vercel KV REST API
 */
async function redisCmd(...args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // If running tests or local development without cloud credentials, use in-memory fallback
    if (process.env.NODE_ENV === "test" || process.env.USE_MEMORY_DB === "true") {
      const [cmd, key, val] = args;
      const upperCmd = (cmd || "").toUpperCase();
      if (upperCmd === "GET") {
        return memoryStore.get(key) || null;
      }
      if (upperCmd === "SET") {
        memoryStore.set(key, val);
        return "OK";
      }
      if (upperCmd === "DEL") {
        memoryStore.delete(key);
        return 1;
      }
    }
    throw new Error("DATABASE_NOT_CONFIGURED: Please connect Upstash Redis in your Vercel Dashboard under the Storage tab.");
  }

  const endpoint = url.replace(/\/+$/, "");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstash Redis error (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.result;
}

/**
 * Hash password using PBKDF2 (SHA-512, 100,000 iterations)
 */
function hashPassword(password, salt) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString("hex");
  }
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

/**
 * Verify password against salt and hash
 */
function verifyPassword(password, salt, hash) {
  const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

/**
 * Create HMAC-SHA256 signed session token (30-day validity)
 */
function createToken(payload) {
  const session = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };
  const data = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/**
 * Verify HMAC-SHA256 session token
 */
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  const expectedSig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  if (signature !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Date.now()) return null; // Expired
    return payload;
  } catch (err) {
    return null;
  }
}

/**
 * Extract auth token from Authorization header (Bearer <token>)
 */
function extractToken(req) {
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

module.exports = {
  redisCmd,
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  extractToken,
};
