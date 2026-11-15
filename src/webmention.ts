import { BASE_URL } from "./config.ts";
import { assertPublicHost } from "./guard.ts";
import { twtHash } from "./hash.ts";
import { addMention, getState } from "./state.ts";
import { parseTwtxt } from "./twtxt.ts";

/**
 * Søren Peter Mørch's twtxt flavour of Webmention
 * (https://darch.dk/mentions-twtxt): a twt is addressed by its timestamp via a
 * text fragment, `feed.txt#:~:text=2024-03-04T17:11:38Z`, because a hash needs
 * the feed url to verify and a timestamp does not.
 */
const FRAGMENT = /:~:text=([^&,]+)/;

function timestampOf(url: URL): string | null {
  const decoded = decodeURIComponent(url.hash);
  const match = FRAGMENT.exec(decoded);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Returns null on success, or a human-readable reason for rejecting. */
export async function receiveWebmention(
  sourceUrl: string,
  targetUrl: string,
): Promise<string | null> {
  let source: URL;
  let target: URL;
  try {
    source = new URL(sourceUrl);
    target = new URL(targetUrl);
  } catch {
    return "source and target must be absolute urls";
  }

  if (!/^https?:$/.test(source.protocol) || !/^https?:$/.test(target.protocol)) {
    return "only http(s) sources and targets are supported";
  }
  if (target.host !== new URL(BASE_URL).host) {
    return "target does not belong to this bridge";
  }

  const targetTs = timestampOf(target);
  if (!targetTs) return "target needs a #:~:text=<timestamp> fragment";

  const state = await getState();
  const post = state.posts.find((p) => p.created === targetTs);
  if (!post) return "no twt on this feed has that timestamp";

  const sourceTs = timestampOf(source);
  if (!sourceTs) return "source needs a #:~:text=<timestamp> fragment";

  if (process.env.ALLOW_PRIVATE_FETCH !== "1") {
    try {
      assertPublicHost(source.host);
    } catch {
      return "source host is not fetchable";
    }
  }

  let body: string;
  try {
    const res = await fetch(`${source.origin}${source.pathname}${source.search}`, {
      headers: { "user-agent": "twtxt-bridge/0.1", accept: "text/plain" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return `source fetch failed: HTTP ${res.status}`;
    body = await res.text();
  } catch (err) {
    return `source fetch failed: ${(err as Error).message}`;
  }

  const claimed = parseTwtxt(body).posts.find((p) => p.created === sourceTs);
  if (!claimed) return "the source feed has no twt with that timestamp";

  const parentHash = twtHash(`${BASE_URL}/twtxt.txt`, post.created, post.text);
  const parsed = parseTwtxt(body);

  await addMention({
    created: claimed.created,
    author: `${source.origin}${source.pathname}`,
    nick: parsed.meta.nick?.[0] ?? source.host,
    text: claimed.text,
    parentHash,
    source: "webmention",
  });

  return null;
}
