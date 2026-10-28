import { session } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = (req: Request) => session(req);
