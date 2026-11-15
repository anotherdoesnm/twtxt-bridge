import { blake2b } from "@noble/hashes/blake2.js";

/** RFC 4648 base32, no padding. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Twt Hash v2 takes effect for twts published at or after this instant. */
const V2_EPOCH_MS = Date.UTC(2026, 6, 1, 0, 0, 0);

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
 * Twt Hash over `feed url \n timestamp \n text`: blake2b-256, base32, lower case.
 *
 * v1 (twts before 2026-07-01T00:00:00Z) keeps the last seven characters;
 * v2 takes the first twelve. The choice is made from the twt's own timestamp,
 * so a feed that serves posts from both sides of the epoch stays consistent
 * with the rest of the network — historical twts must not be re-hashed.
 *
 * The feed URL must be the one the twt is published under (the `# url` field),
 * and the timestamp must be exactly what the feed line says — both feed the
 * hash, so reformatting either one silently breaks every reply that points here.
 */
export function twtHash(feedUrl: string, timestamp: string, text: string): string {
  const payload = `${feedUrl}\n${timestamp}\n${text}`;
  const full = base32(blake2b(new TextEncoder().encode(payload), { dkLen: 32 })).toLowerCase();

  const when = Date.parse(timestamp);
  const preEpoch = Number.isFinite(when) && when < V2_EPOCH_MS;

  return preEpoch ? full.slice(-7) : full.slice(0, 12);
}
