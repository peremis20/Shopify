import { expertReview } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => expertReview(req);
export const POST = (req: Request) => expertReview(req);
