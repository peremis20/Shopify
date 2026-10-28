import { NextRequest, NextResponse } from "next/server";
import { redirectUri, saveConnection, STATE_COOKIE } from "@/lib/analytics/connection";
import { exchangeAuthCode } from "@/lib/analytics/google-auth";
import { listProperties } from "@/lib/analytics/properties";

export const dynamic = "force-dynamic";

function back(req: NextRequest, params: Record<string, string>) {
  const res = NextResponse.redirect(new URL(`/analytics?${new URLSearchParams(params)}`, req.url));
  res.cookies.delete(STATE_COOKIE);
  return res;
}

/** Google redirects here after consent. Saves the connection and picks a starting property. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const error = params.get("error");
  if (error) {
    return back(req, { auth_error: error === "access_denied" ? "Google access was not granted" : error });
  }

  const state = params.get("state");
  const code = params.get("code");
  if (!code || !state || state !== req.cookies.get(STATE_COOKIE)?.value) {
    return back(req, { auth_error: "The sign in link expired. Please try again." });
  }

  try {
    const { refreshToken, email } = await exchangeAuthCode(code, redirectUri(req.nextUrl.origin));
    if (!refreshToken) throw new Error("Google did not return offline access. Please try again.");

    // Start with the first property of each kind so data shows up right away.
    const options = await listProperties({ kind: "oauth", refreshToken });
    await saveConnection({
      refreshToken,
      email,
      gaPropertyId: options.ga.items[0]?.id,
      gscSiteUrl: options.gsc.items[0],
    });
    return back(req, { connected: "1" });
  } catch (err) {
    return back(req, { auth_error: err instanceof Error ? err.message : "Sign in failed" });
  }
}
