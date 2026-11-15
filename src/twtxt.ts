/** Conversion from ActivityPub Note to a single twtxt line. */

const LINE_SEP = "\u2028";
const PLACEHOLDER = "\uE000";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return match?.[2] ?? match?.[3];
}

/**
 * Mastodon writes mentions as `<a class="mention" href="...">@user@host</a>`,
 * which is exactly what the twtxt mention extension wants:
 * `@<user@host url="...">`.
 *
 * Links are swapped for placeholders here and restored only after tag
 * stripping — otherwise the `<nick url>` of a twtxt mention looks like an HTML
 * tag and gets eaten.
 */
function protectLinks(html: string): { text: string; saved: string[] } {
  const saved: string[] = [];

  const text = html.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_whole, attrs: string, inner: string) => {
      const href = attr(attrs, "href");
      const classes = (attr(attrs, "class") ?? "").split(/\s+/);
      const isMention = classes.includes("mention") && !classes.includes("hashtag");
      const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();

      let replacement = label || href || "";
      if (isMention && href && label) {
        const nick = label.replace(/^@/, "");
        replacement = `@<${nick} url="${href}">`;
      }

      saved.push(replacement);
      return `${PLACEHOLDER}${saved.length - 1}${PLACEHOLDER}`;
    },
  );

  return { text, saved };
}

function restoreLinks(text: string, saved: string[]): string {
  return text.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_m, i: string) => saved[Number(i)] ?? "",
  );
}

/**
 * Flattens ActivityPub HTML into one physical line, as twtxt requires.
 * Logical breaks become U+2028.
 */
export function htmlToTwtxt(html: string | undefined | null): string {
  if (!html) return "";

  const { text: protectedText, saved } = protectLinks(html);

  let out = protectedText;
  out = out.replace(/<br\s*\/?>/gi, LINE_SEP);
  out = out.replace(/<\/(p|li|blockquote|div|h[1-6])>/gi, LINE_SEP);
  out = out.replace(/<[^>]*>/g, "");
  out = decodeEntities(out);
  out = restoreLinks(out, saved);

  // a twt must not contain raw newlines
  out = out.replace(/\r\n?/g, " ");
  out = out.replace(/\n/g, " ");
  out = out.replace(/[ \t\f\v]+/g, " ");
  out = out.replace(/\u2028[\s\u2028]*/g, LINE_SEP);
  out = out.trim();

  return out;
}

export interface TwtLine {
  timestamp: Date;
  content: string;
}

function asUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return asUrl(value[0]);
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return asUrl(candidate.href ?? candidate.id ?? candidate.url);
  }
  return undefined;
}

export function noteToTwt(note: Record<string, unknown>): TwtLine | null {
  const content = htmlToTwtxt(note.content as string | undefined);
  if (!content) return null;

  const published = note.published ?? note.updated;
  if (typeof published !== "string") return null;
  const timestamp = new Date(published);
  if (Number.isNaN(timestamp.getTime())) return null;

  const url = asUrl(note.url);
  // A bare permalink adds nothing to the line; Mastodon's own links inside the
  // content are already there.
  void url;

  return { timestamp, content };
}

/** Clips long metadata values without cutting a word in half. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}\u2026`;
}

/** RFC 3339, seconds precision, UTC — the exact form the feed line uses. */
export function rfc3339(when: Date): string {
  return when.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatTwt(line: TwtLine): string {
  return `${rfc3339(line.timestamp)}\t${line.content}`;
}
