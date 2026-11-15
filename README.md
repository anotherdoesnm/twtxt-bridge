# twtxt ↔ ActivityPub bridge (read-only)

A public service that turns any fediverse actor into a **twtxt feed** you can
subscribe to in [twtxt.app](https://twtxt.app) or any other twtxt client.

```
https://bridge.example/@kev@fosstodon.org/twtxt.txt
```

That's the whole product. No accounts, no claiming, no registration.

## Why this shape

prologic tried this twice and stopped both times: first as a feature inside
`yarnd` (Feb 2023, feature-flagged, panics, removed later), then as a
standalone Go service (`git.mills.io/yarnsocial/bridge`, 25 commits in
Nov 2025, `bridge.twtxt.net` is offline today).

The scope that failed was a **multi-tenant service**: registration, feed
ownership verification, shadow feeds for every actor, a store, an operator.
This is the small version: one actor, no identities minted, one direction,
public data only. It exists to prove the protocol work is a weekend, not a
quarter.

## Design

**AP → twtxt only.** The other direction needs identity: a twtxt feed can't
prove it owns an ActivityPub actor, and an AP actor on the bridge's domain is
an identity the bridge would have to own and moderate forever. That is where
both previous attempts drowned. This service never writes to the fediverse.

**The bridge has one actor** (`/users/bridge`). It doesn't publish anything —
it exists because a growing number of instances (mastodon.social,
hachyderm.io, GoToSocial deployments) answer unsigned actor fetches with
`401 Request not signed`. So every fetch goes through Fedify's authenticated
document loader and is HTTP-signed.

**The feed URL is the identity.** It is written into the feed as `# url`, and
twtxt's hash is `sha256(nick + url + timestamp + content)`. Changing the URL
scheme later invalidates every hash and every thread. Pick one and freeze it.
The URL is `/{@user@host}/twtxt.txt`; the router hands the `@`-prefixed form to
the handler as a plain segment.

**Metadata carries the profile**, so the feed looks like a person in a client:

```
# nick = kev
# url = https://bridge.example/@kev@fosstodon.org/twtxt.txt
# avatar = https://cdn.fosstodon.org/...
# description = Used to help run Fosstodon...
# link = Fediverse profile https://fosstodon.org/@kev
#
2026-11-14T09:49:33Z	Microsoft&#39;s outage actually helped me be productive.
```

**One physical line per twt.** ActivityPub HTML is flattened: `<br>` and
`</p>` become U+2028, entities are decoded, real newlines are collapsed, and
mentions become the twtxt extension form `@<user@host url="...">`.

## Publishing

The bridge also hosts one twtxt feed of its own and federates it as
`@bridge@twtxt.doesnmlab.xyz`. It speaks the [twtd API](https://git.mills.io/yarnsocial/twtd/src/branch/main/API.md),
so [twtxt.app](https://twtxt.app) can use it as a publishing backend
(Settings → connect a `twtd` server).

The API token is generated on first boot and printed to the container log:

```sh
docker exec twtxt-bridge cat /data/state.json   # .token
```

| Path | Auth | What |
| --- | --- | --- |
| `GET /twtxt.txt` | no | the feed |
| `GET /api/info` | no | nick, url, avatar, description, links, follower count |
| `GET /api/followers` | yes | who follows: fediverse followers and twtxt readers |
| `POST /api/post` | yes | append a twt and fan out `Create{Note}` |
| `POST /api/profile` | yes | avatar url, description, links |
| `GET /mentions.txt` | no | replies to bridge posts, as a twtxt feed |
| `POST /webmention` | no | twtxt-flavoured webmention receiver |

`POST /api/post` takes `{"text": "..."}`, stamps the time server-side, encodes
newlines as U+2028 and returns `{"created": "..."}`. Delivery happens after the
response: a failing inbox must not make the client think the post was lost.

Incoming `Follow` is accepted with a signed `Accept` and the follower's inbox is
stored; `Undo{Follow}` removes it.

Txtxt clients don't follow — they just fetch — so they are discovered from the
`User-Agent` ([Multi-User User-Agent extension](https://twtxt.dev/exts/multiuser-user-agent.html)):
`twtxt-app/0.1 (+https://…; @nick)` becomes a reader, and the `~who-follows`
form is recorded as a group entry (the resource itself is not expanded yet).
Both kinds come back from `/api/followers` with `via=activitypub` or
`via=user-agent`. Recording is throttled to one write per reader per five
minutes.

## Replies and webmentions

Answers to a bridge post arrive two ways and land in one place:
`https://…/mentions.txt`, a twtxt feed where every reply is a twt with
`(#parenthash)` in front, so a client threads it under the post it answers.

**ActivityPub.** The inbox stores `Create` activities whose `inReplyTo` points
at one of our notes. Note ids are the twt hash (`/notes/<hash>`), so the parent
is derived from the id — no mapping table.

**Webmentions.** The feed declares `# webmention = <base>/webmention`, and
`POST /webmention` implements [Søren Peter Mørch's twtxt variant](https://darch.dk/mentions-twtxt):

```sh
curl -d 'source=https://alice.example/twtxt.txt#:~:text=2026-03-04T17:11:38Z' \
     -d 'target=https://twtxt.doesnmlab.xyz/twtxt.txt#:~:text=2026-03-05T20:33:55Z' \
     https://twtxt.doesnmlab.xyz/webmention
```

A twt is addressed by its timestamp through a text fragment, because a hash
needs the author's feed url to verify and a timestamp does not. The endpoint
fetches the source feed, checks that the claimed line really exists, and only
then stores the mention. Hosts are subject to the same SSRF guard as the reader
(`ALLOW_PRIVATE_FETCH=1` relaxes it for local testing only).

**Sending.** A twt that answers a specific twt (`(#hash)`) and mentions a feed
(`@<nick url="…">`) triggers a webmention to that feed: the bridge fetches it,
reads its `# webmention =` endpoint, finds which line the hash points at, and
POSTs `source`/`target` with both timestamps as text fragments. The fetch is
needed for the endpoint anyway, so it doubles as the hash → timestamp lookup
that twtxt otherwise doesn't give you. Sending happens after the API response;
failures are logged, never surfaced as a failed post.

Two limits worth knowing: a plain mention without a subject sends nothing
(there is no twt to address), and the mentions feed is public — replies are
not secret.

## Endpoints

Live instance: **https://twtxt.doesnmlab.xyz**

| Path | What |
| --- | --- |
| `GET /@user@host/twtxt.txt` | the feed (CORS open, ETag, 304) |
| `GET /api/resolve?handle=@user@host` | returns the feed URL as JSON |
| `GET /actor/bridge` | the bridge actor (signing key) |
| `GET /.well-known/webfinger` | WebFinger for the bridge actor |
| `GET /healthz` | liveness |

## Run

```sh
npm install
PORT=8000 npm start          # BASE_URL defaults to http://localhost:8000
npm test                     # 11 unit tests
npm run typecheck
```

Feeds are cached in `./data/cache.json` for 5 minutes; the signing key lives in
`./data/key.json`. A stale feed is served if a refresh fails, so an instance
hiccup doesn't break subscribers.

Environment:

| var | default | meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:$PORT` | public origin; must be the real one in production |
| `BRIDGE_ACTOR` | `bridge` | actor handle (the URI is `/actor/<id>`) |
| `PORT` | `8000` | listen port |
| `BRIDGE_ACTOR` | `bridge` | actor identifier |
| `CACHE_TTL_MS` | `300000` | feed cache lifetime |
| `MAX_ITEMS` | `40` | posts per feed |
| `THREAD_FETCHES` | `24` | extra fetches per build for thread roots |
| `THREAD_BUDGET_MS` | `7000` | wall-clock ceiling for thread resolution |
| `DATA_DIR` | `./data` | key + cache |

## Deploying behind Traefik

[docker-compose.traefik.yml](deploy/docker-compose.traefik.yml) attaches to an
external `traefik_network` and declares the router explicitly with
`priority=100`, because this box has a catch-all `HostRegexp` router that would
otherwise send the hostname to YunoHost through the frp tunnel.

Three things bit us on the first real deployment, in this order:

1. **Origin.** Behind a proxy Fedify derives the actor origin from the request
   and mints `http://…` ids. `createFederation({ origin: BASE_URL })` fixes it;
   until then every signature carries an `http` keyId, which is unverifiable.
2. **No publicKey.** The actor document needs
   `publicKey: keys[0].cryptographicKey` from `ctx.getActorKeyPairs()`. A
   Person without it looks fine in a browser and gets `401 Public key not found`
   from every Mastodon — the error names the key id, not the missing field.
3. **A keyless actor gets cached.** Mastodon stores the account on first fetch
   and will not re-read the actor while it's fresh, so the fix in (2) does not
   take effect for instances that already fetched the keyless version. That's
   why the actor lives at `/actor/{identifier}` (opaque path, decoupled from the
   WebFinger handle) rather than `/users/bridge`: a new URI is a clean account.

Measured in production: **~47 MB** in the container cgroup (256 MB limit), and
the whole 2 GB VPS stayed at ~450 MB available while building feeds.

## Known limits

- **Authorized fetch needs a public host.** Against `hachyderm.io` or
  `mastodon.social` a `localhost` bridge gets `401`, because they fetch the
  key at `#main-key` to verify the signature and can't reach your machine.
  On the live instance all three now return `200`.
- **20 posts per outbox page.** Mastodon paginates by `max_id`; the bridge
  reads up to three pages (60) and keeps the newest `MAX_ITEMS`. There is no
  full history and no backfill.
- **Boosts are skipped** (they need a second fetch per item).
- **Threading is one level of fidelity.** A reply gets a `(#hash)` subject
  pointing at the *root* of its conversation, which is what lets a client group
  a thread. The hash follows the current spec: blake2b-256 over
  `feed url \n timestamp \n text`, base32, then **last 7 characters for twts
  before 2026-07-01T00:00:00Z (v1)** and **first 12 characters from that epoch
  on (v2)** — chosen per twt timestamp, so posts on both sides of the epoch
  stay compatible and historical twts are never re-hashed. The walk up `inReplyTo` is bounded to 4 hops, 24
  fetches and 7 s per feed build; if it can't reach a true root it emits **no**
  subject rather than a mid-thread hash, because a mid-thread twt renders with
  its own subject prefix and would hash differently. The fediverse still cannot
  answer a twtxt reader — there is no write path.
- **Thread cost.** Resolving roots costs a few fetches per reply, so a cold
  build of a chatty feed takes ~5 s; the 5-minute feed cache and a 6-hour hash
  cache bring warm builds to ~2 s.
- **Single user, single feed.** One identity (`@bridge@…`), one feed. Mirroring
  arbitrary twtxt feeds into ActivityPub — the `yarnsocial/bridge` model, where
  you keep hosting your `.txt` and the bridge polls it — is not implemented:
  it needs a claim/verify flow, per-user actors and a poller.
- **Replies from the fediverse are not stored.** The inbox handles `Follow` and
  `Undo` only; a Mastodon reply to a bridge post is not rendered back into the
  feed yet.
- **No media.** `media: false`; avatar upload and `/media/{name}` are not
  implemented, only an external avatar URL through `POST /api/profile`.
- The bridge is an unauthenticated URL fetcher by design: hosts are normalised
  and IP literals/localhost are refused, but there is no allowlist or rate
  limiter yet. Don't run it on a host with network access you care about until
  that's added.

## Next

1. Write path: implement the twtd API (`/twtxt.txt`, `/api/info`, `/api/post`)
   so twtxt.app can post through the bridge, with the actor delivering `Create`
   to its followers and inbound replies landing back in the feed.
2. Add a `# follow =` list and a per-actor "timeline" feed for the bridge
   actor's own following collection.
3. Rate limit + allowlist before this is exposed to the open internet.

## Deploy on a VPS

Measured footprint: **~130 MB RSS idle**, ~131 MB after building a feed. That's
the module graph, not a cache, so it doesn't grow with traffic. A 512 MB VPS is
comfortable; 256 MB works with the restart policy and the cache/concurrency caps
below.

Files: [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml),
[deploy/Caddyfile](deploy/Caddyfile),
[deploy/twtxt-bridge.service](deploy/twtxt-bridge.service).

```sh
# on the VPS, with bridge.example.org already pointing at it
git clone … twtxt-bridge && cd twtxt-bridge
BASE_URL=https://bridge.example.org docker compose up -d --build

# TLS in front (Caddy gets the cert itself)
cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain
systemctl reload caddy

curl -s https://bridge.example.org/users/bridge | head -c 200
curl -s "https://bridge.example.org/@kev@fosstodon.org/twtxt.txt" | head
```

Compose binds the app to `127.0.0.1:8000`, so only the proxy can reach it. Open
80/443 in the firewall and nothing else.

**`BASE_URL` is not cosmetic.** It becomes the actor id, every feed URL, and the
`# url` line inside the feed — which participates in the twtxt hash. Changing it
after people subscribe invalidates every hash and breaks threads. Set it before
the first request.

Without Docker, use the systemd unit; it runs the same
`node --experimental-strip-types src/server.ts` (Node 22 strips types natively,
so `tsx` is not needed in production).

Once `BASE_URL` is a real HTTPS origin, the instances that answer `401 Request
not signed` today start working: they can finally fetch `#main-key` to verify
our signature. That's the deploy that turns hachyderm and mastodon.social from a
`502` into a feed.
