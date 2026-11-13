import { threadsAuthCallback } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => threadsAuthCallback(req);
