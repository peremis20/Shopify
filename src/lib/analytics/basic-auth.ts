/**
 * Optional password for the dashboard. Set DASHBOARD_PASSWORD to require it
 * (any username works). Returns a 401 response to send, or null to continue.
 * Uses only web APIs so it runs in middleware and in a Neon Function.
 */
export function requirePassword(req: Request): Response | null {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return null;

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      if (decoded.slice(decoded.indexOf(":") + 1) === password) return null;
    } catch {
      /* malformed header, ask again */
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Insights dashboard"' },
  });
}
