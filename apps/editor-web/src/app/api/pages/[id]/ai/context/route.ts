import { getAiChatContext } from "@/server/chat-api";
import { chatDeps } from "@/server/chat-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** この Mac の CLI に渡す文脈（`context/*.md`）。サーバー経路が指示に入れるものと同じ。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getAiChatContext(request, id, chatDeps);
}
