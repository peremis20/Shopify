import crypto from "crypto";

/** AES-256-GCM, with the key derived from a server secret. */

const keyFrom = (secret: string) => crypto.createHash("sha256").update(`insights:${secret}`).digest();

export function encrypt(text: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

/** Returns null when the value was encrypted with a different secret or was altered. */
export function decrypt(value: string, secret: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
