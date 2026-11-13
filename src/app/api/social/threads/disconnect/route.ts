import { threadsDisconnect } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => threadsDisconnect(req);
