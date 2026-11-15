import { createFederation, MemoryKvStore } from "@fedify/fedify";
import { Accept, Follow, Person, Undo } from "@fedify/vocab";
import { BASE_URL, BRIDGE_ACTOR } from "./config.ts";
import { getKeyPair } from "./keys.ts";
import { addFollower, removeFollower } from "./state.ts";

/**
 * The bridge is a single-actor service. We don't federate content of our own —
 * the actor exists so that we can sign outgoing GETs, because a growing number
 * of instances (mastodon.social, hachyderm.io, GoToSocial) answer unsigned
 * actor fetches with 401 "Request not signed".
 */
export const federation = createFederation<void>({
  kv: new MemoryKvStore(),
  // The actor URI is deliberately not /users/{handle}: once an instance has
  // fetched an actor it caches the account, and a keyless first fetch (our
  // first deploy) poisons it for a day. An opaque path also keeps the WebFinger
  // handle decoupled from the URI.
  //
  // Behind a reverse proxy Fedify would otherwise derive the origin from the
  // request (http://…) and mint http actor ids, which the fediverse rejects.
  origin: BASE_URL,
});

federation
  .setActorDispatcher("/actor/{identifier}", async (ctx, identifier) => {
    if (identifier !== BRIDGE_ACTOR) return null;

    // Without this the actor document carries no key at all, and every remote
    // server that verifies our signed GET gets as far as fetching #main-key and
    // then rejects it — which surfaced as 401 from mastodon.social.
    const keys = await ctx.getActorKeyPairs(identifier);

    return new Person({
      publicKey: keys[0]?.cryptographicKey,
      assertionMethods: keys.map((key) => key.multikey),
      id: ctx.getActorUri(identifier),
      preferredUsername: identifier,
      name: "twtxt bridge",
      summary:
        "Serves public ActivityPub actors as twtxt feeds. Read-only; mints no identities.",
      url: new URL(BASE_URL),
      inbox: ctx.getInboxUri(identifier),
      outbox: new URL(`${BASE_URL}/actor/${identifier}/outbox`),
      followers: new URL(`${BASE_URL}/actor/${identifier}/followers`),
      following: new URL(`${BASE_URL}/actor/${identifier}/following`),
    });
  })
  .setKeyPairsDispatcher(async (_ctx, identifier) =>
    identifier === BRIDGE_ACTOR ? [await getKeyPair()] : [],
  );

federation
  .setInboxListeners("/actor/{identifier}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    const actor = await follow.getActor();
    const inbox = actor?.inboxId ?? actor?.endpoints?.sharedInbox ?? null;
    if (!actor?.id || !inbox) return;

    await addFollower(actor.id.href, inbox.href);

    await ctx.sendActivity(
      { identifier: BRIDGE_ACTOR },
      actor,
      new Accept({
        id: new URL(`${actor.id.href}#accepts/follows/${Date.now()}`),
        actor: ctx.getActorUri(BRIDGE_ACTOR),
        object: follow,
      }),
    );
  })
  .on(Undo, async (_ctx, undo) => {
    const object = await undo.getObject();
    if (!(object instanceof Follow)) return;
    const actor = await object.getActor();
    if (actor?.id) await removeFollower(actor.id.href);
  });

