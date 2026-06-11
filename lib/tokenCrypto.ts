/**
 * AES-256-GCM encryption for OAuth tokens stored in Supabase.
 *
 * Requires env var: TOKEN_ENCRYPTION_KEY — a 64-char hex string (32 bytes).
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Encrypted format (all base64url, joined by "."): version.iv.authTag.ciphertext
 * If TOKEN_ENCRYPTION_KEY is not set, encrypt/decrypt are no-ops so the app
 * continues to work while you're setting up the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer | null {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

function toB64(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext; // no-op if key not configured

  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, toB64(iv), toB64(authTag), toB64(encrypted)].join(".");
}

export function decryptToken(stored: string): string {
  const key = getKey();
  if (!key) return stored; // no-op if key not configured

  // If it doesn't look encrypted, return as-is (backwards compat)
  if (!stored.startsWith(`${VERSION}.`)) return stored;

  const parts = stored.split(".");
  if (parts.length !== 4) return stored;

  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const iv = fromB64(ivB64);
  const authTag = fromB64(tagB64);
  const ciphertext = fromB64(dataB64);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
