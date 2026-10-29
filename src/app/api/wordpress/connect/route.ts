import { wordpressConnect } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => wordpressConnect(req);
