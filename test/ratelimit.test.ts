import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { rateLimitKey, resetRateLimiterWarningForTests } from "../src/index.ts";

// P13 (ChatGPT outside read F4): the rate limiter stays fail open when its binding is
// missing (agent-memory do-not-fix, test M5 in catalog.test.ts), but the missing binding is
// logged once per isolate, and an IPv6 client is counted by its /64 prefix.

class NoSpan {
  get isTraced() { return false; }
  setAttribute() {}
  end() {}
}
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: undefined,
  tracing: {
    enterSpan: (_name, callback, ...args) => callback(new NoSpan(), ...args),
    startActiveSpan: (_name, callback, ...args) => callback(new NoSpan(), ...args),
    Span: NoSpan,
  },
};

test("R1: a missing binding still serves the request and warns once per isolate, without request data", async () => {
  resetRateLimiterWarningForTests();
  const original = console.warn;
  const lines: unknown[][] = [];
  console.warn = (...args: unknown[]) => { lines.push(args); };
  try {
    for (let i = 0; i < 3; i++) {
      const r = await worker.fetch(
        new Request("https://mcp.turva.dev/", { headers: { "CF-Connecting-IP": "203.0.113.9" } }),
        {},
        ctx,
      );
      assert.equal(r.status, 200, "fail open is unchanged");
    }
  } finally {
    console.warn = original;
  }
  assert.equal(lines.length, 1, "one warning for three requests");
  const text = lines.flat().join(" ");
  assert.match(text, /RATE_LIMITER/);
  assert.doesNotMatch(text, /203\.0\.113\.9/, "no address in the log");
});

test("R2: a present binding never warns", async () => {
  resetRateLimiterWarningForTests();
  const original = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    await worker.fetch(new Request("https://mcp.turva.dev/"), { RATE_LIMITER: { limit: async () => ({ success: true }) } }, ctx);
  } finally {
    console.warn = original;
  }
  assert.equal(warned, 0);
});

test("R3: two IPv6 addresses in one /64 share a key, another /64 does not", () => {
  const a = rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  const b = rateLimitKey("2001:0DB8:0001:0002::1");
  const c = rateLimitKey("2001:db8:1:3::1");
  assert.equal(a, b, "same /64, compressed and upper case forms included");
  assert.notEqual(a, c);
  assert.equal(rateLimitKey("2001:db8:1:2::1%eth0"), a, "a zone id is dropped");
  assert.equal(rateLimitKey("::1"), rateLimitKey("0:0:0:0:1:2:3:4"), "an all-zero /64 is one key");
});

test("R4: the key a limiter receives for an IPv6 client is the /64, for IPv4 the full address", async () => {
  const keys: string[] = [];
  const env = { RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } };
  for (const ip of ["2001:db8:1:2:1:2:3:4", "2001:db8:1:2:ffff::9", "198.51.100.7"]) {
    await worker.fetch(new Request("https://mcp.turva.dev/", { headers: { "CF-Connecting-IP": ip } }), env, ctx);
  }
  await worker.fetch(new Request("https://mcp.turva.dev/"), env, ctx);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[2], "198.51.100.7");
  assert.equal(keys[3], "no-ip", "a request without the header keeps the shared bucket");
});

test("R5: an IPv4-mapped IPv6 address maps to the IPv4 key", () => {
  assert.equal(rateLimitKey("::ffff:192.0.2.33"), "192.0.2.33");
  assert.equal(rateLimitKey("::FFFF:c000:221"), "192.0.2.33", "hex form of the same mapping");
  assert.equal(rateLimitKey("192.0.2.33"), "192.0.2.33");
});

test("R6: a value that does not parse falls back to the header value itself", () => {
  for (const bad of ["not-an-ip", "2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "12345::1", "::ffff:999.1.1.1", "2001:zz::1"]) {
    assert.equal(rateLimitKey(bad), bad, bad);
  }
  assert.equal(rateLimitKey(null), "no-ip");
  assert.equal(rateLimitKey("  "), "no-ip");
});
