import { socialAgent } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => socialAgent(req);
export const POST = (req: Request) => socialAgent(req);
