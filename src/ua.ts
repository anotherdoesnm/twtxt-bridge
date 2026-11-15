export interface IdentifiedReader {
  nick: string;
  url: string;
  /** true when the client pointed at a who-follows resource instead of a feed */
  group?: boolean;
}

/**
 * Multi-User User-Agent extension (twtxt.dev/exts/multiuser-user-agent.html).
 *
 *   <client>/<version> (+<feed url>; @<nick>)
 *   <client>/<version>@<hash> (~<who-follows url>; contact=<uri>)
 */
export function parseUserAgent(value: string | undefined | null): IdentifiedReader | null {
  if (!value) return null;

  const single = /\(\s*\+(https?:\/\/[^;)\s]+);\s*@([^)\s]+)\)/.exec(value);
  if (single?.[1] && single[2]) {
    return { nick: single[2].replace(/^@/, ""), url: single[1] };
  }

  const group = /\(\s*~(https?:\/\/[^;)\s]+);?/.exec(value);
  if (group?.[1]) {
    let nick = "unknown";
    try {
      nick = `~${new URL(group[1]).host}`;
    } catch {
      // keep the placeholder
    }
    return { nick, url: group[1], group: true };
  }

  return null;
}
