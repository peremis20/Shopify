import { outreachApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => outreachApi(req);
export const POST = (req: Request) => outreachApi(req);
