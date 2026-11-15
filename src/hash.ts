import { blake2b } from "@noble/hashes/blake2.js";

/** RFC 4648 base32, no padding. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/**
 * Twt Hash v1 (twtxt.dev/exts/twt-hash.html): blake2b-256 over
 * `feed url \n timestamp \n text`, base32, lower case, last seven characters.
 *
 * The feed URL must be the one the twt is published under (the `# url` field),
 * and the timestamp must be exactly what the feed line says — both feed the
 * hash, so reformatting either one silently breaks every reply that points here.
 */
export function twtHash(feedUrl: string, timestamp: string, text: string): string {
  const payload = `${feedUrl}\n${timestamp}\n${text}`;
  const digest = blake2b(new TextEncoder().encode(payload), { dkLen: 32 });
  return base32(digest).toLowerCase().slice(-7);
}
