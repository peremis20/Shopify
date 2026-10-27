import { NextResponse } from "next/server";
import { readConnection } from "@/lib/analytics/connection";
import { listProperties } from "@/lib/analytics/properties";

export const dynamic = "force-dynamic";

export async function GET() {
  const conn = readConnection();
  if (!conn) return NextResponse.json({ error: "Connect your Google account first." }, { status: 401 });
  return NextResponse.json(await listProperties({ kind: "oauth", refreshToken: conn.refreshToken }));
}
