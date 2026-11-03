import { nativeAudioContextRoute } from "@/server/audio-api";
import { audioDeps } from "@/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return nativeAudioContextRoute(request, audioDeps);
}
