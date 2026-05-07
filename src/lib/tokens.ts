import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

function getSecret(): string {
  const s = process.env.SERVER_SECRET;
  if (!s) throw new Error("SERVER_SECRET not set");
  return s;
}

export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateInviteCode(): string {
  return randomBytes(12).toString("base64url");
}

// `scope` binds the token to a specific game (and key purpose, e.g. "player" / "invite").
// A token issued for one game can never authorize against another, even if a hash collision occurred.
export function hashToken(rawToken: string, scope: string): Buffer {
  return createHmac("sha256", getSecret())
    .update(scope)
    .update("\0")
    .update(rawToken)
    .digest();
}

export function verifyToken(
  rawToken: string,
  scope: string,
  storedHash: Buffer
): boolean {
  const computed = hashToken(rawToken, scope);
  if (computed.length !== storedHash.length) return false;
  return timingSafeEqual(computed, storedHash);
}

export function byteaParam(b: Buffer): string {
  return "\\x" + b.toString("hex");
}

export function parseBytea(value: string | Buffer | null | undefined): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") {
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  return null;
}
