import { saveKeywordSettings } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => saveKeywordSettings(req);
