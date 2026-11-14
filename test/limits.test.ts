import assert from "node:assert/strict";
import { test } from "node:test";

import { acquire, checkRate, clientIp, release } from "../src/limits.ts";

test("checkRate allows the per-minute budget then blocks", () => {
  const ip = "203.0.113.9";
  for (let i = 0; i < 30; i += 1) {
    assert.equal(checkRate(ip).ok, true, `request ${i + 1} should pass`);
  }
  const verdict = checkRate(ip);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.retryAfter >= 1);
});

test("checkRate keeps separate budgets per IP", () => {
  for (let i = 0; i < 30; i += 1) checkRate("198.51.100.1");
  assert.equal(checkRate("198.51.100.1").ok, false);
  assert.equal(checkRate("198.51.100.2").ok, true);
});

test("acquire caps concurrent work and release wakes a waiter", async () => {
  for (let i = 0; i < 6; i += 1) await acquire();

  let started = false;
  const pending = acquire().then(() => {
    started = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, false, "7th acquire must wait");

  release();
  await pending;
  assert.equal(started, true);

  for (let i = 0; i < 6; i += 1) release();
});

test("clientIp prefers X-Forwarded-For", () => {
  const fromProxy = clientIp({
    req: { header: (name: string) => (name === "x-forwarded-for" ? "1.2.3.4, 10.0.0.1" : undefined) },
    env: {},
  });
  assert.equal(fromProxy, "1.2.3.4");

  const direct = clientIp({
    req: { header: () => undefined },
    env: { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  });
  assert.equal(direct, "127.0.0.1");
});
