import { photoTransferRoutes } from "@/server/photo-transfer/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return photoTransferRoutes.start(request);
}
