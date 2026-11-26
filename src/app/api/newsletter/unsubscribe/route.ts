import { newsletterUnsubscribe } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => newsletterUnsubscribe(req);
export const POST = (req: Request) => newsletterUnsubscribe(req);
