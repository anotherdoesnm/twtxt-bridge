import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRIDGE_ACTOR, DATA_DIR } from "./config.ts";

export interface Post {
  /** RFC 3339, seconds precision, UTC — exactly what the feed line says. */
  created: string;
  text: string;
}

export interface Follower {
  actor: string;
  inbox: string;
  since: string;
}

export interface Mention {
  /** when the reply was published */
  created: string;
  /** fediverse actor id, or the source feed url for a webmention */
  author: string;
  /** display nick */
  nick: string;
  text: string;
  /** twt hash of our post this replies to */
  parentHash: string;
  source: "ap" | "webmention";
}

export interface Reader {
  nick: string;
  url: string;
  group?: boolean;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export interface State {
  token: string;
  nick: string;
  avatar: string;
  description: string;
  links: string[];
  posts: Post[];
  followers: Follower[];
  mentions: Mention[];
  readers: Reader[];
}

const FILE = join(DATA_DIR, "state.json");

let state: State | null = null;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<State> {
  if (state) return state;

  try {
    state = JSON.parse(await readFile(FILE, "utf8")) as State;
    state.posts ??= [];
    state.followers ??= [];
    state.links ??= [];
    state.mentions ??= [];
    state.readers ??= [];
    return state;
  } catch {
    // first run
  }

  state = {
    token: randomBytes(24).toString("base64url"),
    nick: BRIDGE_ACTOR,
    avatar: "",
    description: "A twtxt feed published to the fediverse by twtxt.doesnmlab.xyz",
    links: [],
    posts: [],
    followers: [],
    mentions: [],
    readers: [],
  };
  await persist();
  console.log(`created ${FILE}; API token: ${state.token}`);
  return state;
}

async function persist(): Promise<void> {
  if (!state) return;
  writing = writing.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, FILE);
  });
  await writing;
}

export async function getState(): Promise<State> {
  return load();
}

export async function update<T>(fn: (state: State) => T): Promise<T> {
  const current = await load();
  const result = fn(current);
  await persist();
  return result;
}

export async function addPost(text: string, created: string): Promise<Post> {
  return update((s) => {
    const post: Post = { created, text };
    s.posts.push(post);
    if (s.posts.length > 5000) s.posts.splice(0, s.posts.length - 5000);
    return post;
  });
}

/**
 * Records a twtxt client that fetched the feed. Only writes when the reader is
 * new or hasn't been seen for five minutes, so a polling client doesn't turn
 * every GET into a disk write.
 */
export async function touchReader(reader: { nick: string; url: string; group?: boolean }): Promise<void> {
  const now = Date.now();
  const existing = (await load()).readers.find((r) => r.url === reader.url);
  if (existing && now - Date.parse(existing.lastSeen) < 5 * 60_000) {
    existing.count += 1;
    return;
  }

  await update((s) => {
    const found = s.readers.find((r) => r.url === reader.url);
    const iso = new Date(now).toISOString();
    if (found) {
      found.count += 1;
      found.lastSeen = iso;
      found.nick = reader.nick;
    } else {
      s.readers.push({ ...reader, firstSeen: iso, lastSeen: iso, count: 1 });
      if (s.readers.length > 500) s.readers.splice(0, s.readers.length - 500);
    }
  });
}

export async function addMention(mention: Mention): Promise<void> {
  await update((s) => {
    const duplicate = s.mentions.some(
      (m) => m.author === mention.author && m.created === mention.created && m.parentHash === mention.parentHash,
    );
    if (duplicate) return;
    s.mentions.push(mention);
    if (s.mentions.length > 2000) s.mentions.splice(0, s.mentions.length - 2000);
  });
}

export async function addFollower(actor: string, inbox: string): Promise<void> {
  await update((s) => {
    if (s.followers.some((f) => f.actor === actor)) return;
    s.followers.push({ actor, inbox, since: new Date().toISOString() });
  });
}

export async function removeFollower(actor: string): Promise<void> {
  await update((s) => {
    s.followers = s.followers.filter((f) => f.actor !== actor);
  });
}
