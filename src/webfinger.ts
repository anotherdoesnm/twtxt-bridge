import { assertPublicHost } from "./guard.ts";

export interface Handle {
  user: string;
  host: string;
}

export function parseHandle(input: string): Handle {
  const raw = input.trim().replace(/^@/, "");
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`not a fediverse handle: ${input}`);
  }
  const user = raw.slice(0, at);
  const host = raw.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
    throw new Error(`not a valid host: ${host}`);
  }
  return { user, host };
}

/**
 * Resolves acct:user@host to the actor's ActivityPub id. WebFinger itself is
 * unsigned on every implementation we care about, so this stays cheap.
 */
export async function lookupActorUrl({ user, host }: Handle): Promise<string> {
  assertPublicHost(host);

  const resource = `acct:${user}@${host}`;
  const url = new URL(`https://${host}/.well-known/webfinger`);
  url.searchParams.set("resource", resource);

  const res = await fetch(url, {
    headers: {
      accept: "application/jrd+json, application/json;q=0.9",
      "user-agent": "twtxt-bridge/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`webfinger ${resource}: HTTP ${res.status}`);
  }

  const jrd = (await res.json()) as {
    links?: Array<{ rel?: string; type?: string; href?: string }>;
  };

  const self =
    jrd.links?.find(
      (l) =>
        l.rel === "self" &&
        l.href &&
        (l.type === "application/activity+json" ||
          l.type === "application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\""),
    ) ?? jrd.links?.find((l) => l.rel === "self" && l.href);

  if (!self?.href) {
    throw new Error(`webfinger ${resource}: no ActivityPub self link`);
  }

  return self.href;
}
