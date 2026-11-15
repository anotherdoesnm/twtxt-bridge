import { BASE_URL } from "./config.ts";
import { twtHash } from "./hash.ts";
import { noteToTwt, rfc3339 } from "./twtxt.ts";

type Json = Record<string, any>;
type Loader = (url: string, options?: { signal?: AbortSignal }) => Promise<{ document: any }>;

/**
 * How many extra fetches one feed build may spend on thread resolution.
 * Replies are the expensive part: each one may walk up to the root.
 */
export interface Budget {
  left: number;
  /** Wall-clock deadline: latency matters more than completeness. */
  until?: number;
}

function spent(budget: Budget): boolean {
  return budget.left <= 0 || (budget.until !== undefined && Date.now() > budget.until);
}

const HASH_TTL_MS = 6 * 60 * 60_000;
const MAX_HASHES = 5000;
const MAX_HANDLES = 2000;

const hashes = new Map<string, { hash: string; at: number }>();
const handles = new Map<string, { user: string; host: string } | null>();

function firstUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstUrl(value[0]);
  if (value && typeof value === "object") {
    const obj = value as Json;
    return firstUrl(obj.id ?? obj.href ?? obj.url);
  }
  return undefined;
}

async function loadJson(
  loader: Loader,
  url: string,
  timeoutMs = 6000,
): Promise<Json | null> {
  try {
    const doc = (await loader(url, { signal: AbortSignal.timeout(timeoutMs) }))
      .document as Json;
    return doc ?? null;
  } catch {
    return null;
  }
}

function recall(id: string): string | null {
  const hit = hashes.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > HASH_TTL_MS) {
    hashes.delete(id);
    return null;
  }
  return hit.hash;
}

function remember(ids: string[], hash: string): void {
  const at = Date.now();
  for (const id of ids) {
    if (hashes.size >= MAX_HASHES) {
      const oldest = hashes.keys().next().value;
      if (oldest !== undefined) hashes.delete(oldest);
    }
    hashes.set(id, { hash, at });
  }
}

async function handleFor(
  loader: Loader,
  actorUrl: string,
  budget: Budget,
): Promise<{ user: string; host: string } | null> {
  if (handles.has(actorUrl)) return handles.get(actorUrl) ?? null;
  if (spent(budget)) return null;
  budget.left -= 1;

  const doc = await loadJson(loader, actorUrl);
  let found: { user: string; host: string } | null = null;
  if (doc && typeof doc.preferredUsername === "string") {
    found = { user: doc.preferredUsername, host: new URL(actorUrl).host };
  }

  if (handles.size >= MAX_HANDLES) {
    const oldest = handles.keys().next().value;
    if (oldest !== undefined) handles.delete(oldest);
  }
  handles.set(actorUrl, found);
  return found;
}

/**
 * Returns the twtxt subject `(#hash)` for a reply, or null.
 *
 * The subject carries the hash of the *root* twt of the conversation, not the
 * direct parent — that is what lets clients group a whole thread under one id.
 * So we walk `inReplyTo` up to the root (bounded), render the root exactly the
 * way its own feed would, and hash that.
 */
export async function subjectFor(
  loader: Loader,
  note: Json,
  budget: Budget,
): Promise<string | null> {
  let current: Json = note;
  const chain: string[] = [];
  let deepest: Json | null = null;
  let deepestId: string | null = null;

  for (let depth = 0; depth < 4; depth += 1) {
    const ref = firstUrl(current.inReplyTo);
    if (!ref) break;

    const known = recall(ref);
    if (known) return `(#${known})`;

    if (spent(budget)) return null;
    budget.left -= 1;

    const parent = await loadJson(loader, ref);
    if (!parent) return null;

    chain.push(ref);
    deepest = parent;
    deepestId = ref;
    current = parent;
  }

  if (!deepest || !deepestId) return null;

  // Only a true root can be hashed: a mid-thread note carries its own subject
  // prefix in its feed, which changes its text and therefore its hash. If we
  // stopped early (depth or budget), give up rather than emit a wrong hash.
  if (firstUrl(deepest.inReplyTo)) return null;

  const line = noteToTwt(deepest);
  if (!line) return null;

  const actorUrl = firstUrl(deepest.attributedTo);
  if (!actorUrl) return null;
  const handle = await handleFor(loader, actorUrl, budget);
  if (!handle) return null;

  const feedUrl = `${BASE_URL}/@${handle.user}@${handle.host}/twtxt.txt`;
  const hash = twtHash(feedUrl, rfc3339(line.timestamp), line.content);
  remember([...chain, deepestId], hash);

  return `(#${hash})`;
}
