import { keywordIdeasHandler } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = (req: Request) => keywordIdeasHandler(req);
