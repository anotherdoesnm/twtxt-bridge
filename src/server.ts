import { createHash } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { federation as fedifyMiddleware } from "@fedify/hono";

import { BASE_URL, CACHE_TTL_MS, PORT } from "./config.ts";
import { cacheGet, cacheSet, type CacheEntry } from "./cache.ts";
import { acquire, checkRate, clientIp, release } from "./limits.ts";
import { buildFeed } from "./feed.ts";
import { federation } from "./federation.ts";
import { parseHandle } from "./webfinger.ts";

const app = new Hono();

// DEBUG=1 traces what a remote instance asks for when it verifies a signature.
app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  const path = c.req.path;
  if (process.env.DEBUG && (path.startsWith("/actor") || path.startsWith("/.well-known"))) {
    console.log(
      `${c.req.method} ${path} -> ${c.res.status} accept=${(c.req.header("accept") ?? "").slice(0, 60)} ua=${(c.req.header("user-agent") ?? "").slice(0, 30)} ${Date.now() - started}ms`,
    );
  }
});

// Must be registered before our routes: Fedify serves the bridge actor and the
// bridge's own WebFinger, and calls next() for anything it doesn't own.
app.use("*", fedifyMiddleware(federation, () => undefined));

const inflight = new Map<string, Promise<CacheEntry>>();

function etagFor(text: string): string {
  return `"${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`;
}

function feedUrlFor(user: string, host: string): string {
  return `${BASE_URL}/@${user}@${host}/twtxt.txt`;
}

function plainHeaders(entry: CacheEntry) {
  return {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "ETag",
    "cache-control": "public, max-age=60",
    etag: entry.etag,
    "x-feed-source": entry.actorUrl,
    "x-content-type-options": "nosniff",
  };
}

async function refresh(
  key: string,
  user: string,
  host: string,
): Promise<CacheEntry> {
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    await acquire();
    try {
      const built = await buildFeed({ user, host }, feedUrlFor(user, host));
      return {
        text: built.text,
        etag: etagFor(built.text),
        fetchedAt: Date.now(),
        actorUrl: built.actorUrl,
        handle: key,
      } satisfies CacheEntry;
    } finally {
      release();
    }
  })();

  inflight.set(key, job);
  try {
    const entry = await job;
    await cacheSet(key, entry);
    return entry;
  } finally {
    inflight.delete(key);
  }
}

// Hono's router refuses to match a literal "@" before a parameter, so the
// pretty /@user@host/twtxt.txt URL lands here as handle "@user@host".
app.get("/:handle/twtxt.txt", async (c) => {
  const raw = c.req.param("handle") ?? "";
  let handle;
  try {
    handle = parseHandle(raw);
  } catch (err) {
    return c.text(`${(err as Error).message}\n`, 400);
  }

  const key = `${handle.user}@${handle.host}`.toLowerCase();
  const cached = await cacheGet(key);
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  let entry = cached;
  if (!fresh) {
    const verdict = checkRate(clientIp(c));
    if (!verdict.ok) {
      return c.text("rate limited\n", 429, {
        "retry-after": String(verdict.retryAfter),
      });
    }

    try {
      entry = await refresh(key, handle.user, handle.host);
    } catch (err) {
      console.error(`refresh ${key}: ${(err as Error).message}`);
      if (!cached) {
        return c.text(`could not build feed: ${(err as Error).message}\n`, 502);
      }
      // Serve stale rather than fail: an instance hiccup shouldn't break the
      // subscriber's feed.
      entry = cached;
    }
  }

  if (!entry) return c.text("no feed\n", 502);

  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim() === entry!.etag)) {
    return c.body(null, 304, plainHeaders(entry));
  }

  return c.text(entry.text, 200, plainHeaders(entry));
});

app.get("/api/resolve", async (c) => {
  const raw = c.req.query("handle");
  if (!raw) return c.json({ error: "missing handle" }, 400);
  try {
    const handle = parseHandle(raw);
    return c.json({
      handle: `${handle.user}@${handle.host}`,
      feed: feedUrlFor(handle.user, handle.host),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/healthz", (c) => c.text("ok\n"));

const LANDING = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>twtxt bridge</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9 }
  main { width: min(38rem, 92vw) }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem }
  p.sub { color: #8b949e; margin: 0 0 1.5rem }
  form { display: flex; gap: .5rem }
  input { flex: 1; padding: .7rem .8rem; border-radius: .4rem;
          border: 1px solid #30363d; background: #161b22; color: inherit;
          font: inherit }
  button { padding: .7rem 1rem; border-radius: .4rem; border: 1px solid #30363d;
           background: #238636; color: #fff; font: inherit; cursor: pointer }
  code { background: #161b22; padding: .15rem .35rem; border-radius: .25rem }
  .out { margin-top: 1.25rem; word-break: break-all }
  .out a { color: #58a6ff }
  footer { margin-top: 2rem; color: #6e7681; font-size: .85rem }
</style></head>
<body><main>
  <h1>twtxt ↔ ActivityPub</h1>
  <p class="sub">Paste a fediverse handle, get a twtxt feed. Read-only, no accounts.</p>
  <form method="get" action="/">
    <input name="handle" placeholder="@user@instance.tld" autocomplete="off" autofocus>
    <button type="submit">Feed</button>
  </form>
  <div class="out" id="out"></div>
  <footer>Subscribe to the URL in any twtxt client. Replies are not bridged (yet).</footer>
</main>
<script>
  const params = new URLSearchParams(location.search);
  const handle = params.get("handle");
  if (handle) {
    const url = location.origin + "/@" + handle.replace(/^@/, "") + "/twtxt.txt";
    document.getElementById("out").innerHTML =
      'Feed: <a href="' + url + '">' + url + "</a>";
  }
</script>
</body></html>`;

app.get("/", (c) => c.html(LANDING));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`twtxt bridge listening on ${BASE_URL} (port ${info.port})`);
});
