import { NextRequest, NextResponse } from "next/server";

/**
 * Optional password for the analytics dashboard. Set DASHBOARD_PASSWORD to
 * require it (any username works); leave it unset for open access locally.
 */
export function middleware(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Analytics dashboard"' },
  });
}

export const config = {
  matcher: ["/analytics/:path*", "/api/analytics/:path*", "/api/auth/google/:path*"],
};
