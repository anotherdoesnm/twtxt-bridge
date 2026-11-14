import { fileURLToPath } from "node:url";

export const PORT = Number(process.env.PORT ?? 8000);

export const BASE_URL = (
  process.env.BASE_URL ?? `http://localhost:${PORT}`
).replace(/\/+$/, "");

export const BRIDGE_ACTOR = process.env.BRIDGE_ACTOR ?? "bridge";

export const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));

/** How long a generated feed is served from cache before a refresh. */
export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 300_000);

/** Max posts turned into twts per feed. Keeps the first fetch cheap. */
export const MAX_ITEMS = Number(process.env.MAX_ITEMS ?? 40);

export const KEY_ID = `${BASE_URL}/users/${BRIDGE_ACTOR}#main-key`;
