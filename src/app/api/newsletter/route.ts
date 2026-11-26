import { newsletterApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => newsletterApi(req);
export const POST = (req: Request) => newsletterApi(req);
