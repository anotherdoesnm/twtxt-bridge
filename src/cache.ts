import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export interface CacheEntry {
  text: string;
  etag: string;
  fetchedAt: number;
  actorUrl: string;
  handle: string;
}

const FILE = join(DATA_DIR, "cache.json");

/** Keeps the JSON cache bounded on a small disk. */
const MAX_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES ?? 500);

let entries: Record<string, CacheEntry> = {};
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    entries = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    entries = {};
  }
}

export async function cacheGet(key: string): Promise<CacheEntry | undefined> {
  await load();
  return entries[key];
}

export async function cacheSet(key: string, entry: CacheEntry): Promise<void> {
  await load();
  entries[key] = entry;

  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    const oldest = keys
      .map((k) => [k, entries[k]!.fetchedAt] as const)
      .sort((a, b) => a[1] - b[1]);
    for (const [stale] of oldest.slice(0, keys.length - MAX_ENTRIES)) {
      delete entries[stale];
    }
  }

  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entries));
  await rename(tmp, FILE);
}

export async function cacheList(): Promise<CacheEntry[]> {
  await load();
  return Object.values(entries);
}
