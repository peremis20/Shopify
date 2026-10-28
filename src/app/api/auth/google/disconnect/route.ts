import { NextResponse } from "next/server";
import { deleteConnection, getConnection } from "@/lib/analytics/connection";
import { revokeToken } from "@/lib/analytics/google-auth";

export async function POST() {
  const conn = await getConnection();
  if (conn) await revokeToken(conn.refreshToken);
  await deleteConnection();
  return NextResponse.json({ ok: true });
}
