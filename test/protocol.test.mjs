import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { SERVICES, AGENT_READINESS, SECURITY_EVIDENCE, PRINCIPLES, CONTACT } from "../src/index.ts";

// The MCP endpoint itself, called the way a client calls it. catalog.test.mjs holds the
// discovery routes and the catalogue data. This file holds the protocol: what
// server/discover and tools/list declare, what every tool returns, and the limits the
// Worker sets in front of @modelcontextprotocol/server, which the comments below call the SDK. Before audit round 20 on 2026-09-23 no test sent a single
// MCP request, so a regression in the tools themselves showed only after a deploy.

const ctx = { waitUntil() {}, passThroughOnException() {} };
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
const TOOLS = {
  get_services: SERVICES,
  get_agent_readiness: AGENT_READINESS,
  get_security_evidence: SECURITY_EVIDENCE,
  get_principles: PRINCIPLES,
  get_contact: CONTACT,
};
const plain = (data) => JSON.parse(JSON.stringify(data));

function post(body, headers = {}, env = {}) {
  return worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env, ctx);
}

// The 2025-era lane answers as an event stream, the 2026-07-28 lane as JSON.
async function readJson(r) {
  const text = await r.text();
  if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(data.at(-1));
  }
  return JSON.parse(text);
}

// A request on the 2026-07-28 lane, with the headers and the envelope the revision requires.
async function call(method, params = {}) {
  const headers = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method };
  if (method === "tools/call") headers["Mcp-Name"] = params.name;
  const r = await post({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }, headers);
  assert.equal(r.status, 200, method + " is answered");
  const body = await readJson(r);
  assert.equal(body.error, undefined, method + " returns a result and not an error");
  return body.result;
}

test("P1: server/discover declares what the server does and nothing it does not", async () => {
  const d = await call("server/discover");
  assert.ok(d.supportedVersions.includes("2026-07-28"));
  // The SDK, @modelcontextprotocol/server, sets listChanged to true unless createServer passes a value, and this server
  // never sends notifications/tools/list_changed. Round 20 found this as A1-1.
  assert.deepEqual(d.capabilities, { tools: { listChanged: false } });
  assert.equal(d.ttlMs, 3_600_000);
  assert.equal(d.cacheScope, "public");
  const info = d._meta["io.modelcontextprotocol/serverInfo"];
  assert.equal(info.name, "turva-mcp");
  assert.equal(info.title, "turva.dev");
  assert.equal(info.websiteUrl, "https://turva.dev/");
  assert.ok(info.description, "the identity carries the card's description");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(info.version, pkg.version, "serverInfo and package.json carry one version");
  for (const name of Object.keys(TOOLS)) {
    assert.match(d.instructions, new RegExp("\\b" + name + "\\b"), "the instructions route to " + name);
  }
});

test("P2: subscriptions/listen acknowledges no tools filter, because none can fire", async () => {
  const r = await post(
    { jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen" },
  );
  assert.equal(r.status, 200);
  // The stream stays open for notifications, so only its first event is read.
  const reader = r.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const line = new TextDecoder().decode(value).split(/\r?\n/).find((l) => l.startsWith("data:"));
  const ack = JSON.parse(line.slice(5));
  assert.equal(ack.method, "notifications/subscriptions/acknowledged");
  assert.deepEqual(ack.params.notifications, {});
});

test("P3: tools/list declares five read-only tools that take no arguments and describe their output", async () => {
  const { tools } = await call("tools/list");
  assert.deepEqual(tools.map((t) => t.name), Object.keys(TOOLS));
  for (const t of tools) {
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.deepEqual(t.inputSchema.properties, {}, t.name + " takes no arguments");
    assert.equal(t.inputSchema.additionalProperties, false, t.name + " says it takes no arguments");
    assert.equal(t.outputSchema?.type, "object", t.name + " describes its output");
    assert.equal(t.outputSchema.additionalProperties, false, t.name + " names every field it returns");
    assert.deepEqual(Object.keys(t.outputSchema.properties).sort(), Object.keys(TOOLS[t.name]).sort(), t.name + " schema and data name the same fields");
  }
});

test("P4: every tool returns its data as structuredContent and as the same JSON in text", async () => {
  for (const [name, data] of Object.entries(TOOLS)) {
    const res = await call("tools/call", { name, arguments: {} });
    assert.notEqual(res.isError, true, name);
    assert.deepEqual(res.structuredContent, plain(data), name + " returns its data object");
    assert.equal(res.content[0].type, "text", name);
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent, name + " text carries the same JSON");
  }
});

test("P5: an argument no tool reads is refused as a tool error", async () => {
  const res = await call("tools/call", { name: "get_contact", arguments: { domain: "example.com" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Input validation error/);
});

test("P6: the 2025-era lane declares the same capabilities and serves the same tools", async () => {
  const init = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.title, "turva.dev");
  assert.ok(init.result.instructions, "initialize carries the same instructions");
  const legacy = { "MCP-Protocol-Version": "2025-06-18" };
  const list = await readJson(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, legacy));
  assert.deepEqual(list.result.tools.map((t) => t.name), Object.keys(TOOLS));
  const res = await readJson(await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_contact", arguments: {} } }, legacy));
  assert.deepEqual(res.result.structuredContent, plain(CONTACT));
});

test("P7: a JSON-RPC batch is refused on both lanes", async () => {
  // Round 20, I-1: the 2025-era lane answered a batch of 100 tools/call requests sent in one
  // POST, and the rate limiter in front of it counted one request.
  const legacyBatch = [1, 2, 3].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_services", arguments: {} } }));
  const modernBatch = [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }];
  for (const [batch, label] of [[legacyBatch, "2025-era batch"], [modernBatch, "2026-07-28 batch"], [[], "empty batch"]]) {
    const r = await post(batch);
    assert.equal(r.status, 400, label);
    const body = await r.json();
    assert.equal(body.error.code, -32600, label);
    assert.equal(body.id, null, label);
  }
  // The guard runs before the SDK's Origin check, so a page on another site that sends a
  // batch learns only that batches are refused, which the endpoint tells every caller.
  const fromOtherSite = await post(legacyBatch, { Origin: "https://evil.example" });
  assert.equal(fromOtherSite.status, 400, "the guard answers before the Origin check");
  await fromOtherSite.text();
  const plainFromOtherSite = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Origin: "https://evil.example" });
  assert.equal(plainFromOtherSite.status, 403, "and the Origin check still refuses everything else from that page");
  await plainFromOtherSite.text();
});

test("P8: a body over 64 KiB is refused before the handler reads it", async () => {
  // A2-2 in round 20: nothing capped the body, and 50 MB was read into memory whole.
  const padded = (n) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(n) } });
  const streamed = await post(padded(70_000));
  assert.equal(streamed.status, 413, "a body over the limit");
  assert.equal((await streamed.json()).error.code, -32000);
  assert.equal(streamed.headers.get("access-control-allow-origin"), "https://turva.dev", "the 413 carries the /mcp policy");
  const declared = await post("{}", { "Content-Length": "70000" });
  assert.equal(declared.status, 413, "a Content-Length over the limit, refused before any read");
  await declared.text();
  const under = await post(padded(60_000));
  assert.equal(under.status, 200, "a body under the limit is served");
  await under.text();
});

test("P9: a request on the 2026-07-28 lane without MCP-Protocol-Version is refused", async () => {
  // D-2 in round 20: the SDK reads the version from the body envelope alone, so a request
  // with the envelope and without the header the revision requires was answered normally.
  for (const [headers, label] of [[{ "Mcp-Method": "server/discover" }, "envelope and Mcp-Method"], [{}, "envelope alone"]]) {
    const r = await post({ jsonrpc: "2.0", id: 7, method: "server/discover", params: { _meta: META } }, headers);
    assert.equal(r.status, 400, label);
    const body = await r.json();
    assert.equal(body.error.code, -32020, label);
    assert.match(body.error.message, /MCP-Protocol-Version/, label + ": the message names the missing header");
    assert.equal(body.id, 7, label + ": the error answers the request's id");
  }
  const methodOnly = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { "Mcp-Method": "tools/list" });
  assert.equal(methodOnly.status, 400, "an Mcp-Method header marks a request as 2026-07-28 too");
  await methodOnly.text();
  const legacy = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(legacy.status, 200, "a 2025-era request carries neither and is served as before");
  await legacy.text();
});

test("P10: GET and DELETE on /mcp name what is allowed, and /mcp/ redirects to /mcp", async () => {
  for (const method of ["GET", "DELETE"]) {
    const r = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method }), {}, ctx);
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get("allow"), "POST, OPTIONS", method);
    assert.equal(r.headers.get("allow"), r.headers.get("access-control-allow-methods"), method + ": Allow and the CORS list agree");
    await r.text();
  }
  const slash = await worker.fetch(new Request("https://mcp.turva.dev/mcp/?x=1", { method: "POST" }), {}, ctx);
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get("location"), "/mcp?x=1", "a path, so the redirect cannot leave this host");
  const absoluteForm = await worker.fetch(new Request("http://evil.example/mcp/"), {}, ctx);
  assert.equal(absoluteForm.headers.get("location"), "/mcp", "the request's host is not echoed");
  // A browser does not follow a redirect on a preflight, so OPTIONS /mcp/ is the /mcp preflight.
  const pre = await worker.fetch(new Request("https://mcp.turva.dev/mcp/", {
    method: "OPTIONS",
    headers: { Origin: "https://turva.dev", "Access-Control-Request-Method": "POST" },
  }), {}, ctx);
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  // A rate-limited /mcp/ answers with the /mcp policy too, not the discovery routes' one.
  const limitedSlash = await worker.fetch(new Request("https://mcp.turva.dev/mcp/"), { RATE_LIMITER: { limit: async () => ({ success: false }) } }, ctx);
  assert.equal(limitedSlash.status, 429);
  assert.equal(limitedSlash.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  await limitedSlash.text();
});

test("P11: RateLimit-Policy and the 429 state the quota wrangler.jsonc configures", async () => {
  const conf = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const m = /"limit":\s*(\d+),\s*"period":\s*(\d+)/.exec(conf);
  assert.ok(m, "wrangler.jsonc configures the rate-limit binding");
  const r = await worker.fetch(new Request("https://mcp.turva.dev/"), {}, ctx);
  assert.equal(r.headers.get("ratelimit-policy"), `"default";q=${m[1]};w=${m[2]}`);
  const limited = await worker.fetch(new Request("https://mcp.turva.dev/"), { RATE_LIMITER: { limit: async () => ({ success: false }) } }, ctx);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), m[2]);
  // TJ-2 in round 20 found the binding approximate and counted per location, and the answer
  // says so.
  assert.match(await limited.text(), new RegExp(`about ${m[1]} requests per ${m[2]} seconds`));
});
