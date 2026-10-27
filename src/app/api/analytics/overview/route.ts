import { NextRequest, NextResponse } from "next/server";
import { isRangeKey } from "@/lib/analytics/dates";
import { getOverview } from "@/lib/analytics/overview";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get("range");
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const data = await getOverview(isRangeKey(range) ? range : "28d", refresh);
  return NextResponse.json(data);
}
