import { NextRequest, NextResponse } from "next/server";
import { requirePassword } from "@/lib/analytics/basic-auth";

/** Optional password for the analytics dashboard (see DASHBOARD_PASSWORD). */
export function middleware(req: NextRequest) {
  return requirePassword(req) ?? NextResponse.next();
}

export const config = {
  matcher: ["/analytics/:path*", "/api/analytics/:path*", "/api/auth/google/:path*", "/api/keywords/:path*"],
};
