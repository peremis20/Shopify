import { keywordDifficultyApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = (req: Request) => keywordDifficultyApi(req);
