import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { SERVICES } from "../src/index.ts";

// turva-mcp had no test suite until 2026-09-10 (Tek-384). typecheck alone says nothing
// about runtime behaviour, and the two things this server can get wrong in production,
// the routing contract and the service promises, are both cheap to hold here.
//
// The service catalogue is the half a static check can reach: turva-worker/tools/verify.mjs
// reads the same promises but only with --live, against the deployed server, so a wrong
// deliverable would ship first and fail afterwards. This file catches it before the deploy.

const noLimiter = {}; // no RATE_LIMITER binding: the documented fail-open path
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, opts = {}) =>
  worker.fetch(
    new Request("https://mcp.turva.dev" + path, { method: opts.method || "GET", headers: opts.headers || {} }),
    opts.env || noLimiter,
    ctx,
  );
const limiter = (success) => ({ RATE_LIMITER: { limit: async () => ({ success }) } });

test("M1: the discovery routes answer with the endpoint the card points at", async () => {
  for (const path of ["/", "/.well-known/mcp"]) {
    const r = await call(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), "application/json");
    const b = JSON.parse(await r.text());
    assert.equal(b.name, "turva-mcp");
    assert.equal(b.transport, "streamable-http");
    assert.equal(b.endpoint, "https://mcp.turva.dev/mcp", "the endpoint is the one every card and README names");
  }
  const glama = await call("/.well-known/glama.json");
  assert.equal(glama.status, 200);
  assert.equal(JSON.parse(await glama.text()).maintainers[0].email, "info@turva.dev");
  assert.equal((await call("/ei-ole")).status, 404);
});

test("M2: the discovery routes serve GET, HEAD and OPTIONS and refuse the rest", async () => {
  assert.equal((await call("/", { method: "HEAD" })).status, 200, "HEAD is a GET without the body");
  const pre = await call("/", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  // Round 16 (C7-1, 2026-09-03): POST and DELETE on / used to answer 200 with the same
  // body while the CORS header promised GET and OPTIONS, so the header was a claim the
  // routing did not keep.
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await call("/", { method });
    assert.equal(r.status, 405, method + " on a read-only document");
    assert.equal(r.headers.get("allow"), "GET, HEAD, OPTIONS", method + " names what is allowed");
  }
});

test("M3: every answer carries the security headers", async () => {
  for (const path of ["/", "/.well-known/glama.json", "/ei-ole"]) {
    const h = (await call(path)).headers;
    assert.equal(h.get("x-content-type-options"), "nosniff", path);
    assert.ok(h.get("content-security-policy"), path + " carries a CSP");
    assert.ok(h.get("referrer-policy"), path + " carries a referrer policy");
  }
});

test("M4: the declared rate limit is enforced, and the 429 answers with its own path's policy", async () => {
  const denied = await call("/", { env: limiter(false) });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60", "the declared window, not a guess");
  assert.match(await denied.text(), /100 requests per 60 seconds/);
  // The limiter runs before path routing. Without the split below the 429 on /mcp answered
  // with the discovery routes' wildcard policy, advertising a GET that /mcp itself refuses.
  const onMcp = await call("/mcp", { env: limiter(false) });
  assert.equal(onMcp.status, 429);
  assert.notEqual(
    onMcp.headers.get("access-control-allow-methods"),
    denied.headers.get("access-control-allow-methods"),
    "/mcp does not answer with the discovery routes' method list",
  );
  const allowed = await call("/", { env: limiter(true) });
  assert.equal(allowed.status, 200, "a request under the limit is served normally");
});

test("M5: a limiter that throws fails open rather than taking the endpoint down", async () => {
  const env = { RATE_LIMITER: { limit: async () => { throw new Error("binding on fire"); } } };
  const r = await call("/", { env });
  assert.equal(r.status, 200, "the documented fail-open path");
  const missing = await call("/", { env: {} });
  assert.equal(missing.status, 200, "a missing binding is the same case");
});

test("M6: every service the catalogue sells has a price and a deliverable", async () => {
  const ids = SERVICES.services.map((s) => s.id);
  assert.deepEqual(ids, ["shopify", "audit", "advisory", "implementation", "agent-operations", "mcp-server-design"]);
  for (const s of SERVICES.services) {
    assert.ok(s.name && s.summary && s.deliverable, s.id + " is fully described");
    assert.ok(typeof s.price === "number" || s.price === "on request", s.id + " carries a price or says on request");
  }
  assert.equal(SERVICES.currency, "EUR");
  assert.equal(SERVICES.vat_included, false);
});

// Astra measured the drift 2026-09-10: the audit deliverable had lost the re-scan within
// 30 days of the report that seven places on turva.dev promise, the advisory deliverable
// had lost the monthly written summary, and the Shopify retest gave 14 days without the
// day it counts from. A promise carrying a DATE is the kind an agent acts on.
test("M7: the deliverables still carry the dated promises the site makes", async () => {
  const want = [
    ["audit", /re-scan within 30 days of the report/i],
    ["audit", /round of written follow-up questions/i],
    ["advisory", /monthly re-scan/i],
    ["advisory", /monthly written summary/i],
    ["advisory", /quarterly summary/i],
    ["shopify", /within 48 hours of the agreed written kickoff/i],
    ["shopify", /within 14 days of that first package/i],
  ];
  for (const [id, re] of want) {
    const s = SERVICES.services.find((x) => x.id === id);
    assert.ok(s, id + " is in the catalogue");
    assert.match(s.deliverable, re, id + " deliverable keeps " + re.source);
  }
  // /services says in as many words that a higher score is not guaranteed, so the
  // catalogue may not promise the opposite (measured contradiction, 2026-09-09).
  assert.doesNotMatch(JSON.stringify(SERVICES), /each scanner cycle reads higher/i);
});
