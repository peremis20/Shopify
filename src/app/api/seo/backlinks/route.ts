import { backlinkProspects } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = (req: Request) => backlinkProspects(req);
export const POST = (req: Request) => backlinkProspects(req);
