import crypto from "node:crypto";

export function normalizeCookieInput(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Paste a Cookie header or Cookie-Editor JSON.");
  const raw = input.trim();
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("Cookie-Editor JSON is not valid JSON."); }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : null;
    if (!rows) throw new Error("Cookie-Editor JSON must be an array of cookies or an object with a cookies array.");
    const pairs = rows
      .filter((row) => row && typeof row.name === "string" && typeof row.value === "string")
      .map((row) => [row.name.trim(), row.value].join("="));
    if (!pairs.length) throw new Error("No valid name/value cookies were found.");
    return pairs.join("; ");
  }
  return raw.replace(/^Cookie:\s*/i, "").split(";").map((p) => p.trim()).filter(Boolean).join("; ");
}

export function validateArenaCookieFormat(cookieHeader) {
  const match = cookieHeader.match(/(?:^|;\s*)arena-auth-prod-v1\.0=([^;]+)/);
  if (!match) return { valid: false, message: "Invalid: missing arena-auth-prod-v1.0 cookie." };
  const value = decodeURIComponent(match[1]).trim();
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64");
    if (!decoded.length || decoded.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
      return { valid: false, message: "Invalid: arena-auth-prod-v1.0 does not contain a valid base64 payload." };
    }
  } catch {
    return { valid: false, message: "Invalid: arena-auth-prod-v1.0 payload could not be decoded." };
  }
  return { valid: true, message: "Valid format. Live session status is not confirmed by format validation alone." };
}

function keyBytes() {
  const key = process.env.COOKIE_ENCRYPTION_KEY || "";
  if (/^[a-f0-9]{64}$/i.test(key)) return Buffer.from(key, "hex");
  try {
    const decoded = Buffer.from(key, "base64");
    if (decoded.length === 32) return decoded;
  } catch {}
  throw new Error("COOKIE_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or base64.");
}

export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(value) {
  const [iv, tag, encrypted] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

export function cookieExpiryFromInput(input) {
  if (typeof input !== "string" || !input.trim().startsWith("[") && !input.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(input.trim());
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const row = rows.find((item) => item && item.name === "arena-auth-prod-v1.0");
    const value = row?.expirationDate ?? row?.expires ?? row?.expiry;
    if (value === undefined || value === null || value === "" || value === -1) return null;
    const date = typeof value === "number" ? new Date(value < 100000000000 ? value * 1000 : value) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch { return null; }
}
