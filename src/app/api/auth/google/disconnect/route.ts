import { NextResponse } from "next/server";
import { clearConnection, readConnection } from "@/lib/analytics/connection";
import { revokeToken } from "@/lib/analytics/google-auth";

export async function POST() {
  const conn = readConnection();
  if (conn) await revokeToken(conn.refreshToken);
  const res = NextResponse.json({ ok: true });
  clearConnection(res);
  return res;
}
