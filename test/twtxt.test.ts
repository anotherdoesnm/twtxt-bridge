import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToTwtxt, noteToTwt, formatTwt, clip, decodeEntities } from "../src/twtxt.ts";
import { parseHandle } from "../src/webfinger.ts";

const SEP = "\u2028";

test("paragraphs and breaks become U+2028, never raw newlines", () => {
  const out = htmlToTwtxt("<p>one<br>two</p><p>three</p>");
  assert.equal(out, `one${SEP}two${SEP}three`);
  assert.ok(!out.includes("\n"));
});

test("mentions become twtxt mention syntax", () => {
  const html = '<p>hi <a class="mention" href="https://m.example/@bob">@bob@m.example</a>!</p>';
  assert.equal(htmlToTwtxt(html), 'hi @<bob@m.example url="https://m.example/@bob">!');
});

test("hashtag links are not mistaken for mentions", () => {
  const html = '<p><a class="mention hashtag" href="https://m.example/tags/x">#<span>x</span></a> hi</p>';
  assert.equal(htmlToTwtxt(html), "#x hi");
});

test("entities are decoded", () => {
  assert.equal(htmlToTwtxt("<p>a &amp; b &#39;c&#39; &mdash;</p>"), "a & b 'c' &mdash;");
  assert.equal(decodeEntities("&#x1f600;"), "😀");
});

test("line breaks inside content are flattened", () => {
  assert.equal(htmlToTwtxt("<p>a\nb</p>"), "a b");
});

test("empty content yields nothing", () => {
  assert.equal(htmlToTwtxt(""), "");
  assert.equal(htmlToTwtxt(undefined), "");
  assert.equal(noteToTwt({ content: "<p></p>", published: "2026-01-01T00:00:00Z" }), null);
});

test("noteToTwt keeps the published instant", () => {
  const line = noteToTwt({
    type: "Note",
    content: "<p>hello</p>",
    published: "2026-03-04T05:06:07Z",
  });
  assert.ok(line);
  assert.equal(formatTwt(line!), "2026-03-04T05:06:07Z\thello");
});

test("noteToTwt rejects notes without a timestamp", () => {
  assert.equal(noteToTwt({ content: "<p>x</p>" }), null);
});

test("clip cuts on a word boundary", () => {
  assert.equal(clip("aaa bbb ccc", 8), "aaa bbb…");
  assert.equal(clip("short", 10), "short");
});

test("parseHandle accepts @user@host and user@host", () => {
  assert.deepEqual(parseHandle("@alice@m.example"), { user: "alice", host: "m.example" });
  assert.deepEqual(parseHandle("alice@M.Example"), { user: "alice", host: "m.example" });
});

test("parseHandle rejects junk and bare hosts", () => {
  assert.throws(() => parseHandle("alice"));
  assert.throws(() => parseHandle("alice@localhost"));
  assert.throws(() => parseHandle("@alice@"));
});
