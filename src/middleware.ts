import { NextRequest, NextResponse } from "next/server";
import { requirePassword } from "@/lib/analytics/basic-auth";

/**
 * Optional extra password in front of the dashboard (DASHBOARD_PASSWORD), for
 * private deployments. Shopify and Google callbacks and webhooks stay open
 * because they are verified on their own, and so do the newsletter's unsubscribe
 * links (a random token) and Resend's signed webhook.
 */
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const open =
    ["/api/shopify/", "/api/auth/google/callback"].some((p) => path.startsWith(p)) ||
    ["/api/newsletter/unsubscribe", "/api/newsletter/webhook"].some((p) => path === p || path === `${p}/`);
  return open ? NextResponse.next() : requirePassword(req) ?? NextResponse.next();
}

export const config = {
  matcher: ["/analytics/:path*", "/api/:path*"],
};
