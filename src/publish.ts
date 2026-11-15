import { randomUUID } from "node:crypto";
import { Create, Note } from "@fedify/vocab";
import { BASE_URL, BRIDGE_ACTOR } from "./config.ts";
import { federation } from "./federation.ts";
import { getState } from "./state.ts";

const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** twtxt text -> ActivityPub HTML: escape, and U+2028 is a line break. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\u2028/g, "<br>");
}

/**
 * Publishes one twt as an ActivityPub Create to everyone who follows the
 * bridge actor. Returns the number of inboxes it was delivered to.
 */
export async function publish(text: string, created: string): Promise<number> {
  const state = await getState();
  if (!state.followers.length) return 0;

  const ctx = federation.createContext(new URL(BASE_URL), undefined);
  const actorId = ctx.getActorUri(BRIDGE_ACTOR);
  // Built by hand: the followers collection is a plain route, not a Fedify
  // dispatcher, so ctx.getFollowersUri() would throw.
  const followersUri = new URL(`${BASE_URL}/actor/${BRIDGE_ACTOR}/followers`);
  const id = new URL(`${BASE_URL}/notes/${randomUUID()}`);

  const note = new Note({
    id,
    content: textToHtml(text),
    mediaType: "text/html",
    to: new URL(AS_PUBLIC),
    cc: followersUri,
    attribution: actorId,
  });

  const create = new Create({
    id: new URL(`${id.href}#activity`),
    actor: actorId,
    object: note,
    to: new URL(AS_PUBLIC),
    cc: followersUri,
  });

  const recipients = state.followers.map((follower) => ({
    id: new URL(follower.actor),
    inboxId: new URL(follower.inbox),
  }));

  await ctx.sendActivity({ identifier: BRIDGE_ACTOR }, recipients, create);
  console.log(`published ${created}: delivered to ${recipients.length} inbox(es)`);
  return recipients.length;
}
