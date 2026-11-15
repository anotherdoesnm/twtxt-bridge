import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUserAgent } from "../src/ua.ts";

test("single-follower format", () => {
  assert.deepEqual(
    parseUserAgent("twtxt/1.2.3 (+https://example.com/twtxt.txt; @somebody)"),
    { nick: "somebody", url: "https://example.com/twtxt.txt" },
  );
});

test("twtxt.app's own user agent", () => {
  assert.deepEqual(
    parseUserAgent("twtxt-app/0.1 (+https://you.example.com/twtxt.txt; @you)"),
    { nick: "you", url: "https://you.example.com/twtxt.txt" },
  );
});

test("multi-follower format points at a who-follows resource", () => {
  const parsed = parseUserAgent(
    "twtxt/0.1.0@abcdefg (~https://example.com/whoFollows?token=abc; contact=https://example.com/support)",
  );
  assert.equal(parsed?.group, true);
  assert.equal(parsed?.url, "https://example.com/whoFollows?token=abc");
});

test("browsers and bots are ignored", () => {
  assert.equal(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64)"), null);
  assert.equal(parseUserAgent("curl/8.5.0"), null);
  assert.equal(parseUserAgent(undefined), null);
});

test("a plus link without a nick is not a follower", () => {
  assert.equal(parseUserAgent("twtxt/1.0 (+https://example.com/twtxt.txt)"), null);
});
