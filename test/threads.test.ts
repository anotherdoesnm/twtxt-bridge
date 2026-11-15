import assert from "node:assert/strict";
import { test } from "node:test";

import { BASE_URL } from "../src/config.ts";
import { twtHash } from "../src/hash.ts";
import { subjectFor } from "../src/threads.ts";
import { noteToTwt, rfc3339 } from "../src/twtxt.ts";

type Json = Record<string, any>;

function fixture(prefix: string, depth: number) {
  const actor: Json = {
    id: `https://${prefix}.example/users/bob`,
    type: "Person",
    preferredUsername: "bob",
  };

  const docs: Record<string, Json> = { [actor.id]: actor };
  let parent: string | undefined;

  for (let i = 0; i < depth; i += 1) {
    const id = `https://${prefix}.example/notes/${i}`;
    const note: Json = {
      id,
      type: "Note",
      attributedTo: actor.id,
      content: `<p>note ${i}</p>`,
      published: `2026-01-0${i + 1}T00:00:00Z`,
      ...(parent ? { inReplyTo: parent } : {}),
    };
    docs[id] = note;
    parent = id;
  }

  return { docs, rootId: `https://${prefix}.example/notes/0`, replyId: parent! };
}

const loaderFor = (docs: Record<string, Json>) => async (url: string) => ({
  document: docs[url],
});

function expectedHash(docs: Record<string, Json>, rootId: string): string {
  const root = docs[rootId];
  const line = noteToTwt(root)!;
  const handle = docs[root.attributedTo as string].preferredUsername;
  const host = new URL(root.attributedTo as string).host;
  return twtHash(
    `${BASE_URL}/@${handle}@${host}/twtxt.txt`,
    rfc3339(line.timestamp),
    line.content,
  );
}

test("a reply gets the hash of the root, not of its parent", async () => {
  const { docs, rootId, replyId } = fixture("a", 3);
  const subject = await subjectFor(
    loaderFor(docs),
    docs[replyId]!,
    { left: 8 },
  );
  assert.equal(subject, `(#${expectedHash(docs, rootId)})`);
});

test("no inReplyTo means no subject", async () => {
  const { docs, replyId } = fixture("b", 1);
  const subject = await subjectFor(loaderFor(docs), docs[replyId]!, { left: 8 });
  assert.equal(subject, null);
});

test("an unresolvable parent yields no subject instead of a guess", async () => {
  const { docs, replyId } = fixture("c", 3);
  const note = { ...docs[replyId]!, inReplyTo: "https://gone.example/notes/1" };
  const subject = await subjectFor(loaderFor(docs), note, { left: 8 });
  assert.equal(subject, null);
});

test("a chain deeper than the walk limit is refused, not mis-hashed", async () => {
  const { docs, replyId } = fixture("d", 6);
  const subject = await subjectFor(loaderFor(docs), docs[replyId]!, { left: 8 });
  assert.equal(subject, null);
});

test("the fetch budget stops the walk", async () => {
  const { docs, replyId } = fixture("e", 2);
  const subject = await subjectFor(loaderFor(docs), docs[replyId]!, { left: 0 });
  assert.equal(subject, null);
});
