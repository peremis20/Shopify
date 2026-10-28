import { NextRequest, NextResponse } from "next/server";
import { requirePassword } from "@/lib/analytics/basic-auth";

/**
 * Optional extra password in front of the dashboard (DASHBOARD_PASSWORD), for
 * private deployments. Shopify and Google callbacks and webhooks stay open
 * because they are verified on their own.
 */
export function middleware(req: NextRequest) {
  const open = ["/api/shopify/", "/api/auth/google/callback"].some((p) => req.nextUrl.pathname.startsWith(p));
  return open ? NextResponse.next() : requirePassword(req) ?? NextResponse.next();
}

export const config = {
  matcher: ["/analytics/:path*", "/api/:path*"],
};
