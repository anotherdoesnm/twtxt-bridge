import { BASE_URL, BRIDGE_ACTOR, MAX_ITEMS, MAX_THREAD_FETCHES, THREAD_BUDGET_MS } from "./config.ts";
import { federation } from "./federation.ts";
import { clip, htmlToTwtxt, noteToTwt, formatTwt, type TwtLine } from "./twtxt.ts";
import { lookupActorUrl, type Handle } from "./webfinger.ts";
import { subjectFor, type Budget } from "./threads.ts";

type Json = Record<string, any>;
type Loader = (url: string, options?: { signal?: AbortSignal }) => Promise<{ document: any }>;

export interface BuiltFeed {
  text: string;
  actorUrl: string;
  posts: number;
}

function firstUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstUrl(value[0]);
  if (value && typeof value === "object") {
    const obj = value as Json;
    return firstUrl(obj.id ?? obj.href ?? obj.url);
  }
  return undefined;
}

function imageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return imageUrl(value[0]);
  if (value && typeof value === "object") return imageUrl((value as Json).url);
  return undefined;
}

/** twtxt metadata is one `# key = value` line per entry. */
function meta(key: string, value: string | undefined): string | null {
  if (!value) return null;
  const flat = value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  if (!flat) return null;
  return `# ${key} = ${flat}`;
}

function itemsOf(doc: Json | null | undefined): Json[] {
  const raw = doc?.orderedItems ?? doc?.items;
  return Array.isArray(raw) ? raw : [];
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

/**
 * Reads an outbox collection. Servers disagree on how much of it they expose:
 * Mastodon returns a root with a `first` URL, others inline the first page, and
 * at least one (matrix-appservice-activitypub) writes the root halfway and then
 * stalls forever. So: try the root, then the two common page parameters, and
 * take whatever parses first.
 */
async function collectItems(
  loader: Loader,
  outboxUrl: string,
  limit: number,
): Promise<Json[]> {
  const out: Json[] = [];

  for (const candidate of [outboxUrl, `${outboxUrl}?page=1`, `${outboxUrl}?page=true`]) {
    const doc = await loadJson(loader, candidate);

    if (doc) {
      const inline = (doc as Json).first;
      if (inline && typeof inline === "object") out.push(...itemsOf(inline as Json));
      out.push(...itemsOf(doc));
      if (out.length) break;

      const pageUrl = firstUrl(inline);
      const page = pageUrl ? await loadJson(loader, pageUrl) : null;
      if (page) {
        out.push(...itemsOf(page));
        const moreUrl = firstUrl(page.next);
        if (out.length && out.length < limit && moreUrl) {
          const more = await loadJson(loader, moreUrl);
          if (more) out.push(...itemsOf(more));
        }
      }
    }

    if (out.length) break;
  }

  return out.slice(0, limit);
}

async function resolveObject(loader: Loader, value: unknown): Promise<Json | null> {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return ((await loader(value)).document as Json) ?? null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as Json;
  return null;
}

/** The public timeline of one fediverse actor, as twtxt. */
export async function buildFeed(handle: Handle, feedUrl: string): Promise<BuiltFeed> {
  const actorUrl = await lookupActorUrl(handle);

  const ctx = federation.createContext(new URL(BASE_URL), undefined);
  const loader = (await ctx.getDocumentLoader({
    identifier: BRIDGE_ACTOR,
  })) as unknown as Loader;

  let actor: Json;
  try {
    actor = (await loader(actorUrl)).document as Json;
  } catch (err) {
    const e = err as { status?: number; response?: Response; message?: string };
    const body = e.response ? await e.response.text().catch(() => "") : "";
    console.error(
      `actor fetch ${actorUrl} failed: status=${e.status ?? "?"} message=${e.message ?? ""} body=${body.slice(0, 300)}`,
    );
    throw err;
  }
  if (!actor) throw new Error(`empty actor document for ${actorUrl}`);

  const outboxUrl =
    firstUrl(actor.outbox) ??
    (typeof actor.outbox === "string" ? actor.outbox : undefined) ??
    `${actorUrl}/outbox`;

  const raw = await collectItems(loader, outboxUrl, MAX_ITEMS);

  const notes: Json[] = [];
  let skipped = 0;

  for (const item of raw) {
    const activity = await resolveObject(loader, item);
    if (!activity) {
      skipped += 1;
      continue;
    }

    // Mastodon puts Create activities in the outbox; others put bare objects
    // (matrix-appservice-activitypub emits Notes directly). Boosts are Announce.
    const type = activity.type ?? activity.objectType;
    let note: Json | null;
    if (type === "Create") {
      note = await resolveObject(loader, activity.object);
    } else if (type === "Note" || type === "Article") {
      note = activity;
    } else {
      skipped += 1;
      continue;
    }

    if (!note || (note.type && note.type !== "Note" && note.type !== "Article")) {
      skipped += 1;
      continue;
    }

    notes.push(note);
  }

  // Replies get a `(#hash)` subject pointing at the root of the thread. The
  // walk costs extra fetches, so it runs in parallel and under a deadline.
  const budget: Budget = {
    left: MAX_THREAD_FETCHES,
    until: Date.now() + THREAD_BUDGET_MS,
  };
  // Sequential on purpose: bursting twenty requests at one instance gets us
  // rate-limited, which costs more than the serial latency saves.
  const subjects: Array<string | null> = [];
  for (const note of notes) {
    subjects.push(await subjectFor(loader, note, budget).catch(() => null));
  }

  const lines: TwtLine[] = [];
  for (let i = 0; i < notes.length; i += 1) {
    const twt = noteToTwt(notes[i]!);
    if (!twt) {
      skipped += 1;
      continue;
    }
    const subject = subjects[i];
    if (subject) twt.content = `${subject} ${twt.content}`;
    lines.push(twt);
  }

  lines.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // drop duplicates that show up when an outbox overlaps two pages
  const seen = new Set<string>();
  const unique = lines.filter((line) => {
    const key = formatTwt(line);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const profileUrl = firstUrl(actor.url) ?? actorUrl;
  const header = [
    meta("nick", String(actor.preferredUsername ?? handle.user)),
    meta("url", feedUrl),
    meta("avatar", imageUrl(actor.icon)),
    meta("description", clip(htmlToTwtxt(actor.summary), 280)),
    meta("link", `Fediverse profile ${profileUrl}`),
    "#",
  ].filter(Boolean) as string[];

  const body = unique.map(formatTwt);
  const text = `${header.join("\n")}\n${body.join("\n")}${body.length ? "\n" : ""}`;

  return { text, actorUrl, posts: unique.length };
}
