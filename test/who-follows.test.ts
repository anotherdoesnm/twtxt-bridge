import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWhoFollows } from "../src/who-follows.ts";

test("reads the documented { nick: url } object", () => {
  assert.deepEqual(
    parseWhoFollows({
      somebody: "https://example.com/user/somebody/twtxt.txt",
      someoneelse: "https://example.com/user/someonelse/twtxt.txt",
    }),
    [
      { nick: "somebody", url: "https://example.com/user/somebody/twtxt.txt" },
      { nick: "someoneelse", url: "https://example.com/user/someonelse/twtxt.txt" },
    ],
  );
});

test("drops entries that are not http(s) feed urls", () => {
  assert.deepEqual(
    parseWhoFollows({
      ok: "https://a.example/twtxt.txt",
      local: "/twtxt.txt",
      js: "javascript:alert(1)",
      nested: { url: "https://b.example/twtxt.txt" },
      blank: "",
    }),
    [{ nick: "ok", url: "https://a.example/twtxt.txt" }],
  );
});

test("rejects anything that is not a plain object", () => {
  assert.deepEqual(parseWhoFollows(null), []);
  assert.deepEqual(parseWhoFollows(["a"]), []);
  assert.deepEqual(parseWhoFollows("nope"), []);
});
