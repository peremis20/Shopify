import crypto from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { oauthClient } from "./google-auth";

/**
 * The signed in Google connection lives in an encrypted, http only cookie,
 * so the app needs no database. The cookie holds the refresh token plus the
 * property and site the user picked.
 */

export interface Connection {
  refreshToken: string;
  email?: string;
  gaPropertyId?: string;
  gscSiteUrl?: string;
}

const COOKIE = "insights_google";
export const STATE_COOKIE = "insights_oauth_state";
const MAX_AGE = 60 * 60 * 24 * 180;

function key(): Buffer | null {
  const secret = process.env.SESSION_SECRET || oauthClient()?.secret;
  return secret ? crypto.createHash("sha256").update(`insights:${secret}`).digest() : null;
}

function seal(data: Connection): string {
  const k = key();
  if (!k) throw new Error("Google sign in is not set up on the server.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

function unseal(value: string): Connection | null {
  const k = key();
  if (!k) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed.refreshToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function readConnection(): Connection | null {
  const value = cookies().get(COOKIE)?.value;
  return value ? unseal(value) : null;
}

export function writeConnection(res: NextResponse, data: Connection) {
  res.cookies.set(COOKIE, seal(data), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearConnection(res: NextResponse) {
  res.cookies.delete(COOKIE);
}

/** Where Google sends the user back to. Set APP_URL if the app sits behind a proxy that hides its address. */
export function redirectUri(requestOrigin: string): string {
  const base = process.env.APP_URL?.replace(/\/$/, "") || requestOrigin;
  return `${base}/api/auth/google/callback`;
}
