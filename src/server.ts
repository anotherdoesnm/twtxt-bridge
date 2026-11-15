import { createHash } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { federation as fedifyMiddleware } from "@fedify/hono";

import { BASE_URL, CACHE_TTL_MS, PORT } from "./config.ts";
import { cacheGet, cacheList, cacheSet, type CacheEntry } from "./cache.ts";
import { acquire, checkRate, clientIp, release } from "./limits.ts";
import { buildFeed } from "./feed.ts";
import { publish } from "./publish.ts";
import { addPost, getState, update } from "./state.ts";
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[ch] ?? ch;
  });
}

function postCount(text: string): number {
  return text.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line)).length;
}

async function bridgedFeeds(limit = 200) {
  const entries = await cacheList();
  return entries
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .slice(0, limit)
    .map((entry) => ({
      handle: entry.handle,
      feed: `${BASE_URL}/@${entry.handle}/twtxt.txt`,
      actor: entry.actorUrl,
      posts: postCount(entry.text),
      updatedAt: new Date(entry.fetchedAt).toISOString(),
    }));
}

app.get("/api/feeds", async (c) => {
  const feeds = await bridgedFeeds();
  return c.json({ count: feeds.length, feeds });
});

app.get("/feeds", async (c) => {
  const feeds = await bridgedFeeds();
  const rows = feeds
    .map(
      (feed) => `<tr>
      <td><a href="/@${escapeHtml(feed.handle)}/twtxt.txt">${escapeHtml(feed.handle)}</a></td>
      <td class="num">${feed.posts}</td>
      <td class="when">${escapeHtml(feed.updatedAt.slice(0, 16).replace("T", " "))}</td>
    </tr>`,
    )
    .join("");

  return c.html(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bridged feeds</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 3rem 1rem; display: grid; justify-items: center;
         font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9 }
  main { width: min(46rem, 96vw) }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem }
  p.sub { color: #8b949e; margin: 0 0 1.5rem }
  table { width: 100%; border-collapse: collapse }
  th { text-align: left; font-weight: 500; color: #8b949e; padding: .4rem .5rem;
       border-bottom: 1px solid #30363d }
  td { padding: .45rem .5rem; border-bottom: 1px solid #21262d; vertical-align: top }
  td.num { text-align: right; color: #8b949e }
  td.when { color: #6e7681; white-space: nowrap }
  a { color: #58a6ff; text-decoration: none }
  a:hover { text-decoration: underline }
  .empty { color: #6e7681; padding: 1rem 0 }
  footer { margin-top: 1.5rem; color: #6e7681; font-size: .85rem }
</style></head>
<body><main>
  <h1>Bridged feeds</h1>
  <p class="sub">${feeds.length} fediverse actors currently served as twtxt.</p>
  ${
    feeds.length
      ? `<table><thead><tr><th>feed</th><th class="num">posts</th><th>built</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="empty">Nothing yet — paste a handle on the <a href="/">front page</a>.</p>`
  }
  <footer><a href="/">← new feed</a> · <a href="/api/feeds">json</a></footer>
</main></body></html>`);
});

// --- the bridge's own feed: a twtd-compatible publishing endpoint -----------

async function authorized(c: { req: { header(name: string): string | undefined } }): Promise<boolean> {
  const state = await getState();
  return c.req.header("authorization") === `Bearer ${state.token}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

async function ownFeed(): Promise<string> {
  const state = await getState();
  const lines = [`# nick = ${oneLine(state.nick)}`, `# url = ${BASE_URL}/twtxt.txt`];
  if (state.avatar) lines.push(`# avatar = ${oneLine(state.avatar)}`);
  if (state.description) lines.push(`# description = ${oneLine(state.description)}`);
  for (const link of state.links) if (link) lines.push(`# link = ${oneLine(link)}`);
  lines.push("#");
  for (const post of state.posts) lines.push(`${post.created}\t${post.text}`);
  return `${lines.join("\n")}\n`;
}

app.get("/twtxt.txt", async (c) =>
  c.text(await ownFeed(), 200, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=30",
  }),
);

app.get("/api/info", async (c) => {
  const state = await getState();
  return c.json({
    nick: state.nick,
    url: `${BASE_URL}/twtxt.txt`,
    avatar: state.avatar,
    followers: state.followers.length,
    description: state.description,
    links: state.links,
    media: false,
    follows: false,
    proxy: false,
  });
});

app.get("/api/followers", async (c) => {
  if (!(await authorized(c))) return c.text("unauthorized\n", 401);
  const state = await getState();
  return c.json(
    state.followers.map((follower) => ({
      nick: follower.actor.split("/").filter(Boolean).pop() ?? follower.actor,
      url: follower.actor,
      firstSeen: follower.since,
      lastSeen: follower.since,
      count: 1,
    })),
  );
});

app.post("/api/post", async (c) => {
  if (!(await authorized(c))) return c.text("unauthorized\n", 401);

  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  const raw = body?.text ?? "";
  const text = raw.replace(/\r\n?|\n/g, "\u2028").trim();
  if (!text) return c.text("empty text\n", 400);

  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await addPost(text, created);

  // Delivery happens after the client gets its timestamp back; a failed inbox
  // must not make the client think the post was not saved.
  void publish(text, created).catch((err) => {
    console.error(`publish failed: ${(err as Error).message}`);
  });

  return c.json({ created });
});

app.post("/api/profile", async (c) => {
  if (!(await authorized(c))) return c.text("unauthorized\n", 401);

  const body = (await c.req.json().catch(() => null)) as
    | { avatar?: string; description?: string; links?: string[] }
    | null;
  if (!body) return c.text("bad json\n", 400);

  if (body.avatar !== undefined && body.avatar !== "" && !/^https?:\/\//.test(body.avatar)) {
    return c.text("avatar must be an http(s) url\n", 400);
  }

  const saved = await update((state) => {
    if (body.avatar !== undefined) state.avatar = body.avatar;
    if (body.description !== undefined) state.description = body.description;
    if (Array.isArray(body.links)) state.links = body.links.filter((l) => typeof l === "string");
    return { avatar: state.avatar, description: state.description, links: state.links };
  });

  return c.json(saved);
});

// Collections the actor advertises. Mastodon reads them on profile views only,
// so they are rendered from local state rather than through Fedify dispatchers.
app.get("/actor/:identifier/outbox", async (c) => {
  const state = await getState();
  const actorId = `${BASE_URL}/actor/${c.req.param("identifier")}`;
  const items = state.posts
    .slice(-20)
    .reverse()
    .map((post) => ({
      id: `${BASE_URL}/notes/${encodeURIComponent(post.created)}`,
      type: "Create",
      actor: actorId,
      published: post.created,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorId}/followers`],
      object: {
        id: `${BASE_URL}/notes/${encodeURIComponent(post.created)}`,
        type: "Note",
        attributedTo: actorId,
        content: post.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\u2028/g, "<br>"),
        mediaType: "text/html",
        published: post.created,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    }));

  return c.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorId}/outbox`,
      type: "OrderedCollection",
      totalItems: state.posts.length,
      orderedItems: items,
    },
    200,
    { "content-type": "application/activity+json" },
  );
});

app.get("/actor/:identifier/followers", async (c) => {
  const state = await getState();
  const actorId = `${BASE_URL}/actor/${c.req.param("identifier")}`;
  return c.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorId}/followers`,
      type: "OrderedCollection",
      totalItems: state.followers.length,
      orderedItems: state.followers.map((f) => f.actor),
    },
    200,
    { "content-type": "application/activity+json" },
  );
});

app.get("/actor/:identifier/following", (c) =>
  c.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${BASE_URL}/actor/${c.req.param("identifier")}/following`,
      type: "OrderedCollection",
      totalItems: 0,
      orderedItems: [],
    },
    200,
    { "content-type": "application/activity+json" },
  ),
);

app.get("/healthz", (c) => c.text("ok\n"));

function renderCard(state: Awaited<ReturnType<typeof getState>>): string {
  const avatar = state.avatar
    ? `<img class="avatar" src="${escapeHtml(state.avatar)}" alt="">`
    : `<div class="avatar letter">${escapeHtml(state.nick.slice(0, 1).toUpperCase())}</div>`;

  const links = state.links
    .map((link) => {
      const url = link.split(/\s+/).pop() ?? "";
      const label = link.replace(/\s*\S+$/, "") || url;
      return `<li><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></li>`;
    })
    .join("");

  const posts = state.posts
    .slice(-10)
    .reverse()
    .map(
      (post) =>
        `<li><time>${escapeHtml(post.created.slice(0, 16).replace("T", " "))}</time><p>${escapeHtml(
          post.text.replace(/\u2028/g, "\n"),
        ).replace(/\n/g, "<br>")}</p></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(state.nick)} — twtxt bridge</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 2.5rem 1rem; display: grid; justify-items: center;
         font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9 }
  main { width: min(38rem, 94vw) }
  .card { display: flex; gap: 1rem; align-items: center; margin-bottom: 1.25rem }
  .avatar { width: 74px; height: 74px; border-radius: 50%; object-fit: cover;
            border: 1px solid #30363d; flex: none }
  .avatar.letter { display: grid; place-items: center; background: #161b22;
                   font-size: 1.8rem; color: #58a6ff }
  h1 { font-size: 1.35rem; margin: 0 }
  .desc { color: #8b949e; margin: .25rem 0 0; font-size: .95rem }
  ul.links { list-style: none; padding: 0; margin: .75rem 0 0; display: flex;
             flex-wrap: wrap; gap: .4rem 1rem; font-size: .9rem }
  a { color: #58a6ff; text-decoration: none }
  a:hover { text-decoration: underline }
  h2 { font-size: .85rem; color: #8b949e; font-weight: 500; margin: 2rem 0 .5rem;
       text-transform: uppercase; letter-spacing: .06em }
  ul.posts { list-style: none; padding: 0; margin: 0 }
  ul.posts li { padding: .6rem 0; border-bottom: 1px solid #21262d }
  ul.posts time { color: #6e7681; font-size: .78rem }
  ul.posts p { margin: .2rem 0 0; white-space: normal; word-break: break-word }
  form { display: flex; gap: .5rem; margin-top: .75rem }
  input { flex: 1; padding: .6rem .7rem; border-radius: .4rem; border: 1px solid #30363d;
          background: #161b22; color: inherit; font: inherit; font-size: .9rem }
  button { padding: .6rem .9rem; border-radius: .4rem; border: 1px solid #30363d;
           background: #238636; color: #fff; font: inherit; font-size: .9rem; cursor: pointer }
  .out { margin-top: .75rem; word-break: break-all; font-size: .9rem }
  footer { margin-top: 2rem; color: #6e7681; font-size: .8rem; display: flex;
           gap: 1rem; flex-wrap: wrap }
</style></head>
<body><main>
  <div class="card">
    ${avatar}
    <div>
      <h1>${escapeHtml(state.nick)}</h1>
      <p class="desc">${escapeHtml(state.description)}</p>
      ${links ? `<ul class="links">${links}</ul>` : ""}
    </div>
  </div>

  <h2>Recent twts</h2>
  ${posts ? `<ul class="posts">${posts}</ul>` : `<p class="desc">Nothing posted yet.</p>`}

  <h2>Follow someone from the fediverse</h2>
  <p class="desc">Paste a handle and get a twtxt feed for it. Read-only, no account.</p>
  <form method="get" action="/">
    <input name="handle" placeholder="@user@instance.tld" autocomplete="off">
    <button type="submit">Feed</button>
  </form>
  <div class="out" id="out"></div>

  <footer>
    <a href="/twtxt.txt">twtxt.txt</a>
    <a href="/feeds">what is bridged</a>
    <a href="/api/info">api</a>
  </footer>
</main>
<script>
  const handle = new URLSearchParams(location.search).get("handle");
  if (handle) {
    const url = location.origin + "/@" + handle.replace(/^@/, "") + "/twtxt.txt";
    document.getElementById("out").innerHTML =
      'Feed: <a href="' + url + '">' + url + "</a>";
  }
</script>
</body></html>`;
}

app.get("/", async (c) => c.html(renderCard(await getState())));

serve({ fetch: app.fetch, port: PORT }, async (info) => {
  // Touch the state at boot so the API token is logged once, not on first use.
  await getState();
  console.log(`twtxt bridge listening on ${BASE_URL} (port ${info.port})`);
});
