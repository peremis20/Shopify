import { siteDisconnect } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => siteDisconnect(req);
