import test from "node:test";
import assert from "node:assert/strict";
import { withRetry, readBody, describeNetworkError } from "../lib/net.mjs";
const refused = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
test("retries thrown network errors and 502/503/504, never 4xx, and resends the same request", async () => {
  const seen = [];
  let n = 0;
  const flaky = withRetry(
    async (url, init) => {
      seen.push(init);
      n++;
      if (n === 1) throw refused();
      if (n === 2)
        return new Response("<html>bad gateway</html>", { status: 502 });
      return new Response('{"ok":true}', { status: 201 });
    },
    { baseDelay: 1 },
  );
  const r = await flaky("https://derp.example/api/votes", {
    method: "POST",
    body: '{"k":1}',
  });
  assert.equal(r.status, 201);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((i) => i.body === '{"k":1}' && i.redirect === "error"));
  let calls = 0;
  const fourxx = withRetry(
    async () => (calls++, new Response("{}", { status: 429 })),
    { baseDelay: 1 },
  );
  assert.equal((await fourxx("https://derp.example/x")).status, 429);
  assert.equal(calls, 1);
  // Last attempt returns the 503 instead of throwing.
  const down = withRetry(async () => new Response("{}", { status: 503 }), {
    baseDelay: 1,
  });
  assert.equal((await down("https://derp.example/x")).status, 503);
});
test("persistent failures produce an actionable message", async () => {
  const dead = withRetry(
    async () => {
      throw refused();
    },
    { baseDelay: 1 },
  );
  await assert.rejects(dead("https://derp.example/api/index"), (e) => {
    assert.match(
      e.message,
      /Could not reach DerpMeter: the connection was refused/,
    );
    assert.match(e.message, /try again in a moment/);
    assert.doesNotMatch(e.message, /derp\.example|https?:/);
    return true;
  });
  const dns = describeNetworkError("https://x.trycloudflare.com/a", {
    cause: { code: "ENOTFOUND" },
  });
  assert.match(dns.message, /could not be resolved/);
  // A caller deadline stops further retries.
  const ctrl = new AbortController();
  let tries = 0;
  const slow = withRetry(
    async () => {
      tries++;
      ctrl.abort();
      throw new DOMException("aborted", "AbortError");
    },
    { baseDelay: 1 },
  );
  await assert.rejects(slow("https://derp.example/x", { signal: ctrl.signal }));
  assert.equal(tries, 1);
});
test("non-JSON bodies become a readable error", async () => {
  assert.deepEqual(await readBody(new Response('{"a":1}')), { a: 1 });
  assert.match(
    (await readBody(new Response("<html>", { status: 502 }))).error,
    /HTTP 502/,
  );
});
