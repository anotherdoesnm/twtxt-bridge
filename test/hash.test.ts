import assert from "node:assert/strict";
import { test } from "node:test";

import { base32, twtHash } from "../src/hash.ts";

// Official reference vectors from twtxt.dev/exts/twt-hash-v2.html
const VECTORS = [
  {
    url: "https://example.com/twtxt.txt",
    at: "2026-07-01T00:00:00Z",
    text: "Hello World!",
    hash: "myzxbwxktuvs",
    why: "on the epoch is v2",
  },
  {
    url: "https://example.com/twtxt.txt",
    at: "2025-04-29T12:00:00Z",
    text: "Hello World!",
    hash: "om5qesa",
    why: "before the epoch is v1",
  },
  {
    url: "https://twtxt.net/twtxt.txt",
    at: "2024-12-31T23:59:59Z",
    text: "Happy New Year!",
    hash: "jcezvlq",
    why: "old twt is v1",
  },
  {
    url: "https://example.com/hugo",
    at: "2026-12-28T14:00:00+01:00",
    text: "(#1234567890ab) Sounds good!",
    hash: "v4yu3xmr65z7",
    why: "non-UTC offset still hashes as written",
  },
];

for (const v of VECTORS) {
  test(`hash: ${v.why}`, () => {
    assert.equal(twtHash(v.url, v.at, v.text), v.hash);
  });
}

test("v2 hashes are twelve characters, v1 are seven", () => {
  assert.match(twtHash("https://e.example/twtxt.txt", "2026-08-01T00:00:00Z", "x"), /^[a-z2-7]{12}$/);
  assert.match(twtHash("https://e.example/twtxt.txt", "2026-06-30T23:59:59Z", "x"), /^[a-z2-7]{7}$/);
});

test("base32 encodes without padding", () => {
  assert.equal(base32(new Uint8Array([0x66])), "MY");
  assert.equal(base32(new TextEncoder().encode("foobar")), "MZXW6YTBOI");
});

test("different feed urls produce different hashes", () => {
  const a = twtHash("https://a.example/twtxt.txt", "2026-08-01T00:00:00Z", "x");
  const b = twtHash("https://b.example/twtxt.txt", "2026-08-01T00:00:00Z", "x");
  assert.notEqual(a, b);
});
