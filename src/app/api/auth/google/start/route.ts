import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { redirectUri, signInAvailable, STATE_COOKIE } from "@/lib/analytics/connection";
import { OAUTH_SCOPES, oauthClient } from "@/lib/analytics/google-auth";

export const dynamic = "force-dynamic";

/** Sends the user to Google's consent screen. */
export function GET(req: NextRequest) {
  const client = oauthClient();
  if (!client || !signInAvailable()) {
    return NextResponse.redirect(new URL("/analytics?auth_error=Google+sign+in+is+not+set+up+yet", req.url));
  }

  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(req.nextUrl.origin),
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();

  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
