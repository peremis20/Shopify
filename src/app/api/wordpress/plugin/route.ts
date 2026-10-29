import { wordpressPlugin } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => wordpressPlugin(req);
