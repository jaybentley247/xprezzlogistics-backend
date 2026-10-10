// Stateless admin tokens: "<base64url payload>.<hmac signature>".
// Signed with TOKEN_SECRET, so they survive server restarts.
const crypto = require("node:crypto");

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function issueToken(username, secret) {
  const payload = Buffer.from(
    JSON.stringify({ sub: username, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

function requireAdmin(secret) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!verifyToken(token, secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}

module.exports = { issueToken, verifyToken, requireAdmin, safeEqual };
