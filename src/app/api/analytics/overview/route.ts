import { NextRequest, NextResponse } from "next/server";
import { isRangeKey } from "@/lib/analytics/dates";
import { getConnection } from "@/lib/analytics/connection";
import { getOverview } from "@/lib/analytics/overview";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get("range");
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    const data = await getOverview(isRangeKey(range) ? range : "28d", await getConnection(), refresh);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Couldn't reach the database: ${message}` }, { status: 500 });
  }
}
