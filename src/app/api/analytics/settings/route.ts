import { NextRequest, NextResponse } from "next/server";
import { getConnection, saveConnection } from "@/lib/analytics/connection";

/** Saves which GA4 property and Search Console site the dashboard reads. */
export async function POST(req: NextRequest) {
  const conn = await getConnection();
  if (!conn) return NextResponse.json({ error: "Connect your Google account first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const gaPropertyId = typeof body.gaPropertyId === "string" ? body.gaPropertyId.trim() : "";
  const gscSiteUrl = typeof body.gscSiteUrl === "string" ? body.gscSiteUrl.trim() : "";
  if (gaPropertyId && !/^\d+$/.test(gaPropertyId)) {
    return NextResponse.json({ error: "That Google Analytics property ID doesn't look right." }, { status: 400 });
  }

  await saveConnection({
    ...conn,
    gaPropertyId: gaPropertyId || undefined,
    gscSiteUrl: gscSiteUrl || undefined,
  });
  return NextResponse.json({ ok: true });
}
