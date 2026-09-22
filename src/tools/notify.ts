import { countedFetch, type FetchCtx } from "./http";

/** Push a message to the phone via ntfy.sh. No-op when NTFY_TOPIC is unset. */
export async function notify(
  ctx: FetchCtx,
  topic: string | undefined,
  msg: { title: string; body: string; click?: string; priority?: 1 | 2 | 3 | 4 | 5 }
): Promise<boolean> {
  if (!topic) return false;
  const headers: Record<string, string> = { title: msg.title, priority: String(msg.priority ?? 3), markdown: "yes" };
  if (msg.click) headers.click = msg.click;
  const res = await countedFetch(ctx, `https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers,
    body: msg.body.slice(0, 4000)
  });
  return res.ok;
}
