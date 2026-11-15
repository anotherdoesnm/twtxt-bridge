import assert from "node:assert/strict";
import { test } from "node:test";

import { base32, twtHash } from "../src/hash.ts";

test("hash matches the reference (python blake2b + base32) implementation", () => {
  const url = "https://twtxt.doesnmlab.xyz/@kev@fosstodon.org/twtxt.txt";
  assert.equal(twtHash(url, "2026-11-14T09:49:33Z", "hello world"), "wi4cjoq");
});

test("hash is seven lower-case base32 characters", () => {
  const hash = twtHash("https://example.com/twtxt.txt", "2026-01-01T00:00:00Z", "x");
  assert.match(hash, /^[a-z2-7]{7}$/);
});

test("base32 encodes without padding", () => {
  assert.equal(base32(new Uint8Array([0x66])), "MY");
  assert.equal(base32(new TextEncoder().encode("foobar")), "MZXW6YTBOI");
});

test("different feed urls produce different hashes", () => {
  const a = twtHash("https://a.example/twtxt.txt", "2026-01-01T00:00:00Z", "x");
  const b = twtHash("https://b.example/twtxt.txt", "2026-01-01T00:00:00Z", "x");
  assert.notEqual(a, b);
});
