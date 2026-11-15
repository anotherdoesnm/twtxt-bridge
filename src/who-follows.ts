import { assertPublicHost } from "./guard.ts";
import { touchReader } from "./state.ts";

/**
 * The multi-follower User-Agent points at a "who follows" resource: a JSON
 * object of `{ "<nick>": "<feed url>" }`. Multi-user clients (yarn pods) hide
 * their users behind it, so this is the only way to see who they are.
 */
export function parseWhoFollows(payload: unknown): Array<{ nick: string; url: string }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];

  const members: Array<{ nick: string; url: string }> = [];
  for (const [nick, feed] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof feed !== "string" || !/^https?:\/\//.test(feed)) continue;
    if (!nick.trim()) continue;
    members.push({ nick: nick.trim(), url: feed });
  }
  return members;
}

const resolved = new Map<string, number>();
const TTL_MS = 60 * 60_000;
const MAX_MEMBERS = 100;

/**
 * Expands a who-follows resource into individual readers. Returns false when
 * the resource couldn't be read, so the caller can fall back to recording the
 * group itself.
 */
export async function expandWhoFollows(resource: string): Promise<boolean> {
  const last = resolved.get(resource);
  if (last !== undefined && Date.now() - last < TTL_MS) return true;

  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;

  if (process.env.ALLOW_PRIVATE_FETCH !== "1") {
    try {
      assertPublicHost(url.host);
    } catch {
      return false;
    }
  }

  resolved.set(resource, Date.now());

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "twtxt-bridge/0.1" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;

    const members = parseWhoFollows(await res.json()).slice(0, MAX_MEMBERS);
    for (const member of members) {
      await touchReader({ ...member, group: true });
    }
    return members.length > 0;
  } catch {
    return false;
  }
}
