import { inspectorReport } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = (req: Request) => inspectorReport(req);
