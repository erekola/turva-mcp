import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { SERVICES, AGENT_READINESS, SECURITY_EVIDENCE, PRINCIPLES, CONTACT, NO_ARGUMENT_TOOL_NAMES } from "../src/index.ts";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";

// The MCP endpoint itself, called the way a client calls it. catalog.test.ts holds the
// discovery routes and the catalogue data. This file holds the protocol: what
// server/discover and tools/list declare, what every tool returns, and the limits the
// Worker sets in front of @modelcontextprotocol/server, which the comments below call the SDK. Before audit round 20 on 2026-09-23 no test sent a single
// MCP request, so a regression in the tools themselves showed only after a deploy.

type Env = Parameters<typeof worker.fetch>[1];
// worker.fetch reads nothing from the context, so every member is a no-op; the span mock
// exists only so the object satisfies ExecutionContext without a cast.
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
// Open-ended JSON-RPC payloads: the tests read many method-specific fields off them.
type Result = Record<string, any>;
interface RpcError { code: number; message: string; data?: { tool: { name: string; truncated: boolean } } }
interface Rpc { id?: number | string; method?: string; params?: Result; result?: Result; error?: RpcError }
interface Tool {
  name: string;
  annotations: unknown;
  inputSchema: { type: string; properties: unknown; additionalProperties: boolean };
  outputSchema?: { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
}
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
const plain = (data: unknown) => JSON.parse(JSON.stringify(data));
// The 2026-07-28 lane is exactly this version header. Any other request is the legacy lane.
const MODERN_LIST_HEADERS = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" };

function post(body: unknown, headers: Record<string, string> = {}, env: Env = {}) {
  return worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env, ctx);
}

// The 2025-era lane answers as an event stream, the 2026-07-28 lane as JSON.
async function readJson(r: Response): Promise<Rpc> {
  const text = await r.text();
  if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(data.at(-1)!);
  }
  return JSON.parse(text);
}

// A request on the 2026-07-28 lane, with the headers and the envelope the revision requires.
async function call(method: string, params: { name?: string; arguments?: object } = {}): Promise<Result> {
  const headers: Record<string, string> = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method };
  if (method === "tools/call") headers["Mcp-Name"] = params.name!;
  const r = await post({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }, headers);
  assert.equal(r.status, 200, method + " is answered");
  const body = await readJson(r);
  assert.equal(body.error, undefined, method + " returns a result and not an error");
  return body.result!;
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
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const line = new TextDecoder().decode(value).split(/\r?\n/).find((l) => l.startsWith("data:"));
  const ack = JSON.parse(line!.slice(5));
  assert.equal(ack.method, "notifications/subscriptions/acknowledged");
  assert.deepEqual(ack.params.notifications, {});
});

test("P3: tools/list declares five read-only tools that take no arguments and describe their output", async () => {
  const { tools } = await call("tools/list") as { tools: Tool[] };
  assert.deepEqual(tools.map((t) => t.name), Object.keys(TOOLS));
  for (const t of tools) {
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.deepEqual(t.inputSchema.properties, {}, t.name + " takes no arguments");
    assert.equal(t.inputSchema.additionalProperties, false, t.name + " says it takes no arguments");
    assert.equal(t.outputSchema?.type, "object", t.name + " describes its output");
    assert.equal(t.outputSchema!.additionalProperties, false, t.name + " names every field it returns");
    assert.deepEqual(Object.keys(t.outputSchema!.properties).sort(), Object.keys(TOOLS[t.name as keyof typeof TOOLS]).sort(), t.name + " schema and data name the same fields");
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
  // The raw __proto__ guard (P13) must not catch an ordinary extra key: that one stays with
  // the SDK's own schema check and its own message.
  assert.doesNotMatch(res.content[0].text, /unrecognized key\(s\) in object/);
});

test("P6: the 2025-era lane declares the same capabilities and serves the same tools", async () => {
  const init = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.deepEqual(init.result!.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result!.serverInfo.title, "turva.dev");
  assert.ok(init.result!.instructions, "initialize carries the same instructions");
  const legacy = { "MCP-Protocol-Version": "2025-06-18" };
  const list = await readJson(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, legacy));
  assert.deepEqual(list.result!.tools.map((t: Tool) => t.name), Object.keys(TOOLS));
  const res = await readJson(await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_contact", arguments: {} } }, legacy));
  assert.deepEqual(res.result!.structuredContent, plain(CONTACT));
});

test("P7: a JSON-RPC batch is refused on both lanes, and the error id follows the lane", async () => {
  // Round 20, I-1: the 2025-era lane answered a batch of 100 tools/call requests sent in one
  // POST, and the rate limiter in front of it counted one request.
  const legacyBatch = [1, 2, 3].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_services", arguments: {} } }));
  const modernBatch = [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }];
  for (const [batch, label] of [[legacyBatch, "2025-era batch"], [modernBatch, "2026-07-28 batch"], [[], "empty batch"]] as [unknown, string][]) {
    // Legacy lane (no version header): JSON-RPC 2.0 section 5 asks for id null when the id
    // could not be read, and a batch has no single id to answer.
    const r = await post(batch);
    assert.equal(r.status, 400, label);
    const body = await r.json() as Rpc;
    assert.equal(body.error!.code, -32600, label);
    assert.equal(body.id, null, label + ": legacy lane, id null");
    // 2026-07-28 lane: T-02 (Astra audit 2026-09-26), the revision's JSONRPCErrorResponse allows
    // id to be a string, a number or absent, so the field is omitted there.
    const modern = await post(batch, MODERN_LIST_HEADERS);
    assert.equal(modern.status, 400, label + ": 2026-07-28 lane");
    const modernBody = await modern.json() as Rpc;
    assert.equal(modernBody.error!.code, -32600, label + ": 2026-07-28 lane");
    assert.equal("id" in modernBody, false, label + ": 2026-07-28 lane, no id field");
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

test("P7b: a batch is refused on a negotiated 2025-03-26 session too, and a single request there is served", async () => {
  // MCP-01 (S5 triage 2026-11-05): the 2025-03-26 revision requires a server to accept batches.
  // This endpoint negotiates that revision and refuses every batch on every lane on purpose
  // (Tek-458 P1(a)), because one POST must not carry many tools/call requests past the rate limit.
  const init = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(init.result!.protocolVersion, "2025-03-26", "the revision is negotiated");
  const old = { "MCP-Protocol-Version": "2025-03-26" };
  const batch = await post([
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ], old);
  assert.equal(batch.status, 400);
  const batchBody = await batch.json() as Rpc;
  assert.equal(batchBody.error!.code, -32600);
  assert.equal(batchBody.id, null, "legacy lane: id null");
  // Control: a single request with the same header is served.
  const single = await readJson(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, old));
  assert.deepEqual(single.result!.tools.map((t: Tool) => t.name), Object.keys(TOOLS));
});

test("P8: a body over 64 KiB is refused before the handler reads it", async () => {
  // A2-2 in round 20: nothing capped the body, and 50 MB was read into memory whole.
  const padded = (n: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(n) } });
  const streamed = await post(padded(70_000));
  assert.equal(streamed.status, 413, "a body over the limit");
  assert.equal(((await streamed.json()) as Rpc).error!.code, -32000);
  assert.equal(streamed.headers.get("access-control-allow-origin"), "https://turva.dev", "the 413 carries the /mcp policy");
  const declared = await post("{}", { "Content-Length": "70000" });
  assert.equal(declared.status, 413, "a Content-Length over the limit, refused before any read");
  await declared.text();
  const under = await post(padded(60_000));
  assert.equal(under.status, 200, "a body under the limit is served");
  await under.text();
  // G-248: the boundary itself. The pad is sized so the whole JSON text is exactly the
  // wanted number of bytes (the text is ASCII, so characters are bytes).
  const exact = (bytes: number) => {
    const body = padded(bytes - padded(0).length);
    assert.equal(new TextEncoder().encode(body).length, bytes, "the test body has the exact size");
    return body;
  };
  const atLimit = await post(exact(65_536));
  assert.equal(atLimit.status, 200, "a body of exactly 65 536 bytes is served");
  await atLimit.text();
  const overByOne = await post(exact(65_537));
  assert.equal(overByOne.status, 413, "a body of 65 537 bytes is refused");
  assert.equal(((await overByOne.json()) as Rpc).error!.code, -32000);
});

test("P9: a request on the 2026-07-28 lane without MCP-Protocol-Version is refused", async () => {
  // D-2 in round 20: the SDK reads the version from the body envelope alone, so a request
  // with the envelope and without the header the revision requires was answered normally.
  for (const [headers, label] of [[{ "Mcp-Method": "server/discover" }, "envelope and Mcp-Method"], [{}, "envelope alone"]] as [Record<string, string>, string][]) {
    const r = await post({ jsonrpc: "2.0", id: 7, method: "server/discover", params: { _meta: META } }, headers);
    assert.equal(r.status, 400, label);
    const body = await r.json() as Rpc;
    assert.equal(body.error!.code, -32020, label);
    assert.match(body.error!.message, /MCP-Protocol-Version/, label + ": the message names the missing header");
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

test("P12: malformed initialize and tools/list params are refused as Invalid params, not Internal error", async () => {
  // Astra audit 2026-09-26, T-01/F-01: the SDK's own schema validation for these two
  // methods threw a plain Error on a malformed shape, which its catch defaulted to
  // -32603 Internal error instead of -32602 Invalid params.
  const missingParams = await readJson(await post({ jsonrpc: "2.0", id: 27, method: "initialize" }));
  assert.equal(missingParams.error!.code, -32602, "initialize with no params at all");
  assert.equal(missingParams.id, 27);
  const missingCapabilities = await readJson(await post({
    jsonrpc: "2.0", id: 28, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(missingCapabilities.error!.code, -32602, "initialize with no capabilities");
  const badVersionType = await readJson(await post({
    jsonrpc: "2.0", id: 32, method: "initialize",
    params: { protocolVersion: 42, capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(badVersionType.error!.code, -32602, "initialize with a numeric protocolVersion");
  const cursorNumber = await readJson(await post(
    { jsonrpc: "2.0", id: 7, method: "tools/list", params: { cursor: 123, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
  ));
  assert.equal(cursorNumber.error!.code, -32602, "tools/list with a numeric cursor");
  assert.equal(cursorNumber.id, 7);
  // The check answers only the malformed shapes above; a well-formed initialize still works.
  const stillWorks = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(stillWorks.error, undefined, "a well-formed initialize is unaffected");
});

test("P5b: a tool error echoes a limited part of what the caller wrote as argument keys", async () => {
  // A client should hand a tool execution error to the model (MCP 2026-07-28, Error Handling),
  // so caller text in it is model context. The server cuts an unknown tool name at 64
  // characters (P19), and the same limit holds for argument keys. Measured before this fix:
  // a key of 2 000 characters came back whole in 2 085 characters of text.
  const longKey = "k".repeat(2000);
  const long = await call("tools/call", { name: "get_services", arguments: { [longKey]: 1 } });
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, /Input validation error/);
  assert.equal(long.content[0].text.includes(longKey), false);
  assert.ok(long.content[0].text.includes("k".repeat(64)), "the cut key still names the key");
  assert.equal(long.content[0].text.includes("k".repeat(65)), false);
  // Many short keys cannot add up to the same echo: at most five are listed.
  const manyKeys = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`key_${"x".repeat(50)}_${i}`, 1]));
  const many = await call("tools/call", { name: "get_services", arguments: manyKeys });
  assert.equal(many.isError, true);
  assert.ok(many.content[0].text.length < 600, `the text was ${many.content[0].text.length} characters`);
  assert.match(many.content[0].text, /and 495 more/);
  // A long key after a short one is cut as well, whatever its position.
  const mixed = await call("tools/call", { name: "get_services", arguments: { a: 1, [longKey]: 1 } });
  assert.equal(mixed.isError, true);
  assert.equal(mixed.content[0].text.includes("k".repeat(65)), false);
  // Up to the limit nothing changes: the SDK's own check and its own message answer.
  const atLimit = await call("tools/call", { name: "get_services", arguments: { ["k".repeat(64)]: 1 } });
  assert.equal(atLimit.isError, true);
  assert.doesNotMatch(atLimit.content[0].text, /unrecognized key\(s\) in object/);
  assert.ok(atLimit.content[0].text.includes("k".repeat(64)));
});

test("P13: a raw __proto__ argument key is refused the same way any other extra key is", async () => {
  // Astra audit 2026-09-26, T-04: a "{ __proto__: x }" literal sets a prototype and makes no own
  // key, but JSON.parse keeps it as a real own property, so a raw JSON body can carry what an
  // object literal in this test file cannot: the body below is built as a literal string,
  // not an object literal, so the key survives into the request the same way it did in the
  // audit's own reproduction.
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const r = await post(raw, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_contact" });
  const body = await readJson(r);
  assert.equal(body.id, 42);
  assert.equal(body.result!.isError, true);
  assert.match(body.result!.content[0].text, /Input validation error/);
  // W16 F1: the 2026-07-28 lane carries resultType on this hand-built result too.
  assert.equal(body.result!.resultType, "complete");
  // The legacy lane keeps its earlier bytes: no resultType.
  const legacyRaw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}}}}';
  const legacy = await readJson(await post(legacyRaw));
  assert.equal(legacy.result!.isError, true);
  assert.equal(legacy.result!.resultType, undefined);
  // The set this check applies to is exactly the five argumentless tools, not every tool name.
  assert.deepEqual([...NO_ARGUMENT_TOOL_NAMES].sort(), Object.keys(TOOLS).sort());
});

test("P14: subscriptions/listen closes itself right after the acknowledgement", async () => {
  // Astra audit 2026-09-26, E-01: the stream used to stay open on a 15 s keepalive that
  // nothing here ever ended. It should now read the acknowledgement, then a Graceful
  // Closure completion frame, then end by itself, with no timer left running.
  const r = await post(
    { jsonrpc: "2.0", id: 5, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen" },
  );
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  const messages = chunks.join("").split("\n\n")
    .filter((frame) => frame.startsWith("event: message"))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)));
  assert.equal(messages.length, 2, "the acknowledgement and the completion, nothing more");
  assert.equal(messages[0].method, "notifications/subscriptions/acknowledged");
  assert.equal(messages[1].id, 5);
  assert.equal(messages[1].result.resultType, "complete");
  assert.equal(messages[1].result._meta[SUBSCRIPTION_ID_META_KEY], 5);
});

test("P14b: subscriptions/listen on the 2025-era lane is answered exactly once", async () => {
  // G-48: with no MCP-Protocol-Version header the SDK does not know the method and answers
  // -32601 as an SSE frame. closeListenStreamAfterAck used to append its Graceful Closure
  // result after that error, so one request got two frames with the same id.
  const r = await post({ jsonrpc: "2.0", id: 5, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } });
  assert.equal(r.status, 200);
  const frames = (await r.text()).split("\n\n")
    .filter((frame) => frame.startsWith("event: message"))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)) as Rpc);
  assert.equal(frames.length, 1, "one request, one response");
  assert.equal(frames[0].id, 5);
  assert.equal(frames[0].error!.code, -32601);
  assert.equal(frames[0].result, undefined, "no completion result follows the error");
});

test("P14c: a request id that holds the acknowledgement method name on the 2025-era lane is still answered once", async () => {
  // Round 2026-11-05: the check used to look for the method name anywhere in the first chunk, so
  // an error frame that echoed a caller's id holding that string read as the acknowledgement and
  // got a completion frame after it. The method is now read from the parsed frame data.
  const id = "notifications/subscriptions/acknowledged";
  const r = await post({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } });
  assert.equal(r.status, 200);
  const frames = (await r.text()).split("\n\n")
    .filter((frame) => frame.startsWith("event: message"))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)) as Rpc);
  assert.equal(frames.length, 1, "one request, one response");
  assert.equal(frames[0].error!.code, -32601);
  assert.equal(frames[0].result, undefined, "no completion result follows the error");
});

test("P15: a disallowed Origin is refused before the malformed-params and __proto__ checks", async () => {
  // B1 (Astra audit 2026-09-28, V02-REGRESSIO / V02-T02): T-01 and T-04 (P12, P13
  // above) used to answer before guardMcpPost reached the SDK's Origin check, so a
  // disallowed Origin combined with a malformed params shape or a raw "__proto__" key
  // read -32602 or a tool error instead of the 403 every other request from that
  // Origin gets. Same malformed shapes as P12 and P13, now sent from a disallowed
  // Origin: all three must now read 403, matching a well-formed request from that
  // Origin (plainFromOtherSite in P7).
  const evilOrigin = { Origin: "https://evil.example" };
  const badCursor = await post(
    { jsonrpc: "2.0", id: 7, method: "tools/list", params: { cursor: 123, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list", ...evilOrigin },
  );
  assert.equal(badCursor.status, 403, "malformed params from a disallowed Origin");
  const badCursorBody = await badCursor.json() as Rpc;
  assert.equal(badCursorBody.error!.code, -32000);
  assert.equal("id" in badCursorBody, false, "B2: the 2026-07-28 lane has no id field");
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const protoFromEvil = await post(raw, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_contact", ...evilOrigin });
  assert.equal(protoFromEvil.status, 403, "a raw __proto__ key from a disallowed Origin");
  assert.equal("id" in ((await protoFromEvil.json()) as Rpc), false, "B2: the 2026-07-28 lane has no id field");
  // The decided order of the guard before the Origin check (Tek-458 P7): a batch and an oversized body still answer 400
  // and 413 before Origin is even considered, unchanged by B1.
  const batchFromEvil = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], evilOrigin);
  assert.equal(batchFromEvil.status, 400, "a batch from a disallowed Origin still reads 400, not 403");
  await batchFromEvil.text();
  const padded = (n: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(n) } });
  const oversizeFromEvil = await post(padded(70_000), evilOrigin);
  assert.equal(oversizeFromEvil.status, 413, "an oversized body from a disallowed Origin still reads 413, not 403");
  await oversizeFromEvil.text();
  // A well-formed request from the same Origin still reads the plain 403, unaffected.
  const plain = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, evilOrigin);
  assert.equal(plain.status, 403, "a well-formed request from the same Origin");
  assert.equal(((await plain.json()) as Rpc).id, null, "legacy lane (no version header): id null");
  // A missing Origin, the case a non-browser client sends, is unaffected.
  const noOrigin = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(noOrigin.status, 200, "no Origin header at all is not a browser request and passes");
  await noOrigin.text();
});

test("P16: an unknown tool name is refused with a capped, separate data field", async () => {
  // P19 (Astra audit 2026-09-26, 32/T2-03): the SDK's own "Tool <name> not found"
  // echoed the caller's name into the message text verbatim and without a length
  // limit. This is answered by guardMcpPost before the SDK ever sees the request.
  const short = await readJson(await post(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "probe tool name with spaces", arguments: {}, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "probe tool name with spaces" },
  ));
  assert.equal(short.error!.code, -32602);
  assert.equal(short.id, 3);
  assert.doesNotMatch(short.error!.message, /probe tool name with spaces/, "the name is not spliced into the message text");
  assert.equal(short.error!.data!.tool.name, "probe tool name with spaces");
  assert.equal(short.error!.data!.tool.truncated, false);
  const longName = "x".repeat(200);
  const long = await readJson(await post(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: longName, arguments: {}, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": longName },
  ));
  assert.equal(long.error!.data!.tool.name.length, 64, "the echoed name is capped at 64 characters");
  assert.equal(long.error!.data!.tool.truncated, true);
  assert.doesNotMatch(JSON.stringify(long), new RegExp(longName), "the full 200-character name never appears anywhere in the response");
  // A known tool name is unaffected.
  const known = await call("tools/call", { name: "get_contact" });
  assert.notEqual(known.isError, true);
});

test("P17: a disallowed Origin is refused with the lane's id shape when Content-Type is not JSON", async () => {
  // V02-2 (Astra audit 2026-09-28, 3rd round): the JSON-Content-Type path already answers a
  // disallowed Origin with the lane's id shape (P15 above), but a POST whose Content-Type is not
  // JSON used to skip guardMcpPost's own Origin check entirely and reach the SDK's own check.
  // This checks the non-JSON path matches: id null on the legacy lane, no id on the modern one.
  const r = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  }), {}, ctx);
  assert.equal(r.status, 403);
  const body = await r.json() as Rpc;
  assert.equal(body.error!.code, -32000);
  assert.match(body.error!.message, /Invalid Origin/);
  assert.equal(body.id, null, "legacy lane (no version header): id null");
  const modernEvil = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example", ...MODERN_LIST_HEADERS },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  }), {}, ctx);
  assert.equal(modernEvil.status, 403);
  assert.equal("id" in (await modernEvil.json() as Rpc), false, "2026-07-28 lane: no id field");
  // An allowed Origin with a non-JSON Content-Type is unaffected: the Origin check passes and
  // the SDK answers its own way for the wrong Content-Type, not refused as a 403 here.
  const allowed = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://turva.dev" },
    body: "not json",
  }), {}, ctx);
  assert.notEqual(allowed.status, 403, "an allowed Origin is not refused by the Origin check");
  await allowed.text();
  // No Origin header at all (a non-browser client) is unaffected on the non-JSON path too.
  const noOrigin = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not json",
  }), {}, ctx);
  assert.notEqual(noOrigin.status, 403, "no Origin header is not a browser request and is not refused here");
  await noOrigin.text();
});

test("P17c: a body not declared as JSON is answered 415 by the Worker with the lane's id shape", async () => {
  // The SDK answers 415 with "id":null, which the 2026-07-28 revision does not allow, so the
  // Worker answers it itself after the Origin check. Same code and message as the SDK, with no id
  // field on the 2026-07-28 lane and id null on the legacy lane.
  const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
  const modern = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" };
  for (const [lane, extra] of [["current", modern], ["legacy", {}]] as const) {
    const wrongType = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Accept: "application/json, text/event-stream", ...extra },
      body,
    }), {}, ctx);
    assert.equal(wrongType.status, 415, lane);
    const wrongTypeBody = await wrongType.json() as Rpc;
    assert.equal(wrongTypeBody.error!.code, -32000, lane);
    assert.equal(wrongTypeBody.error!.message, "Unsupported Media Type: Content-Type must be application/json", lane);
    if (lane === "current") assert.equal("id" in wrongTypeBody, false, `${lane}: no id key`);
    else assert.equal(wrongTypeBody.id, null, `${lane}: id null`);
    // A request with no Content-Type header at all is refused the same way.
    const noType = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", ...extra },
      body: new Uint8Array(new TextEncoder().encode(body)),
    }), {}, ctx);
    assert.equal(noType.status, 415, `${lane}: no Content-Type`);
    const noTypeBody = await noType.json() as Rpc;
    if (lane === "current") assert.equal("id" in noTypeBody, false, `${lane}: no Content-Type, no id key`);
    else assert.equal(noTypeBody.id, null, `${lane}: no Content-Type, id null`);
  }
  // A disallowed Origin keeps its 403 ahead of the 415.
  const evil = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body,
  }), {}, ctx);
  assert.equal(evil.status, 403);
  await evil.text();
  // A charset parameter is a JSON Content-Type to the SDK and still reaches it.
  const charset = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }, { ...modern, "Content-Type": "application/json; charset=utf-8" });
  assert.notEqual(charset.status, 415, "application/json with a charset is not refused");
  assert.equal(charset.status, 200);
  await charset.text();
});

test("P17b: a JSON body that does not parse is answered by the Worker with 400 and the lane's id shape", async () => {
  // W16 U1 (ChatGPT review 2026-10-02): the SDK answers a parse error with "id":null, which the
  // 2026-07-28 revision does not allow, so the Worker answers it itself: the id field is absent
  // on the 2026-07-28 lane and null on the legacy lane, which sends no such header.
  const cut = '{"jsonrpc":"2.0","id":"x","method":"tools/ca';
  for (const [headers, lane] of [[{}, "legacy"], [{ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" }, "current"]] as [Record<string, string>, string][]) {
    const r = await post(cut, headers);
    assert.equal(r.status, 400);
    const body = await r.json() as Rpc;
    assert.equal(body.error!.code, -32700);
    assert.equal(body.error!.message, "Parse error: Invalid JSON");
    if (lane === "current") assert.equal("id" in body, false, "no id field");
    else assert.equal(body.id, null, "id null");
  }
  // A disallowed Origin on an unparseable body keeps its 403.
  const evil = await post(cut, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  await evil.text();
});
test("P18: a malformed clientInfo in initialize is refused as Invalid params, not Internal error", async () => {
  // V02-UUSI-1 (Astra audit 2026-09-28, 3rd round): invalidParamsReason checked
  // protocolVersion and capabilities but not clientInfo, so a clientInfo of the wrong type
  // reached the SDK's own schema validation unguarded and read -32603 Internal error, the
  // same class of bug P12 above already fixed for protocolVersion and capabilities.
  const badClientInfoType = await readJson(await post({
    jsonrpc: "2.0", id: 31, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: "not-an-object" },
  }));
  assert.equal(badClientInfoType.error!.code, -32602, "clientInfo as a string");
  assert.equal(badClientInfoType.id, 31);
  const missingClientInfo = await readJson(await post({
    jsonrpc: "2.0", id: 33, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {} },
  }));
  assert.equal(missingClientInfo.error!.code, -32602, "clientInfo missing entirely");
  const badNameType = await readJson(await post({
    jsonrpc: "2.0", id: 34, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: 1, version: "1.0" } },
  }));
  assert.equal(badNameType.error!.code, -32602, "clientInfo.name not a string");
  const badVersionType = await readJson(await post({
    jsonrpc: "2.0", id: 35, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "x", version: 1 } },
  }));
  assert.equal(badVersionType.error!.code, -32602, "clientInfo.version not a string");
  // A well-formed initialize is unaffected.
  const stillWorks = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(stillWorks.error, undefined, "a well-formed initialize is unaffected");
});

// S5 round (triage of 2026-11-05, decided by the foreman under Tek-546). The error id follows the
// lane. The 2026-07-28 lane is a request that carries exactly MCP-Protocol-Version: 2026-07-28,
// and its errors never carry a null id. Every other request is the legacy lane: no header, a
// legacy revision and an unknown version too. There JSON-RPC 2.0 section 5 asks for id null when
// the id could not be read.

test("P19: a request with a wrong or missing jsonrpc member, or an unsafe id, is an invalid request", async () => {
  // MCP-03: the Worker's own guards used to dispatch on method and id alone, so these answered
  // 200 with -32602, or ran the __proto__ branch, where the SDK answers 400 with -32600.
  const unknown = { name: "missing", arguments: {} };
  const cases: [string, unknown][] = [
    ["jsonrpc 1.0 and an unknown tool", { jsonrpc: "1.0", id: 12, method: "tools/call", params: unknown }],
    ["jsonrpc absent and an unknown tool", { id: 12, method: "tools/call", params: unknown }],
    ["a fractional id and an unknown tool", { jsonrpc: "2.0", id: 1.5, method: "tools/call", params: unknown }],
    ["an id beyond the safe integers and an unknown tool", '{"jsonrpc":"2.0","id":1e30,"method":"tools/call","params":{"name":"missing","arguments":{}}}'],
    ["jsonrpc 1.0 and a numeric cursor", { jsonrpc: "1.0", id: 12, method: "tools/list", params: { cursor: 0 } }],
    ["jsonrpc 1.0 and a raw __proto__ argument", '{"jsonrpc":"1.0","id":12,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}}}}'],
  ];
  for (const [label, body] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, label);
    const parsed = await readJson(r);
    assert.equal(parsed.error!.code, -32600, label);
  }
});

test("P19c: control: well-formed requests keep their earlier answers, and a wrong jsonrpc version is refused", async () => {
  const unknownInt = await readJson(await post({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "missing", arguments: {} } }));
  assert.equal(unknownInt.error!.code, -32602);
  assert.equal(unknownInt.id, 12);
  const unknownStr = await readJson(await post({ jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "missing", arguments: {} } }));
  assert.equal(unknownStr.error!.code, -32602);
  assert.equal(unknownStr.id, "abc");
  const badCursor = await readJson(await post({ jsonrpc: "2.0", id: 13, method: "tools/list", params: { cursor: 123 } }));
  assert.equal(badCursor.error!.code, -32602);
  assert.equal(badCursor.id, 13);
  // The SDK refuses a valid request of the wrong envelope on its own, so this was already right.
  const wrongVersion = await post({ jsonrpc: "1.0", id: 12, method: "tools/list" });
  assert.equal(wrongVersion.status, 400);
  assert.equal((await readJson(wrongVersion)).error!.code, -32600);
});

test("P20: nested and optional initialize parameters of the wrong type are Invalid params, not Internal error", async () => {
  // MCP-04: invalidParamsReason checked the top level and clientInfo.name and version, so a
  // nested field of the wrong type reached the SDK's own schema and read -32603 with the schema
  // library's issue list as the message. The SDK's own schema now decides, and the message names
  // the path alone.
  const clientInfo = (extra: Record<string, unknown>) => ({ clientInfo: { name: "x", version: "1", ...extra } });
  const cases: [string, Record<string, unknown>][] = [
    ["params.capabilities.roots", { capabilities: { roots: 42 } }],
    ["params.capabilities.roots.listChanged", { capabilities: { roots: { listChanged: 42 } } }],
    ["params.capabilities.sampling", { capabilities: { sampling: 42 } }],
    ["params.capabilities.elicitation", { capabilities: { elicitation: 42 } }],
    ["params.capabilities.tasks", { capabilities: { tasks: 42 } }],
    ["params.clientInfo.title", clientInfo({ title: 42 })],
    ["params.clientInfo.description", clientInfo({ description: 42 })],
    ["params.clientInfo.websiteUrl", clientInfo({ websiteUrl: 42 })],
    ["params.clientInfo.icons", clientInfo({ icons: 42 })],
    ["params.clientInfo.icons.0.src", clientInfo({ icons: [{ src: 42 }] })],
  ];
  for (const [path, patch] of cases) {
    const r = await readJson(await post({
      jsonrpc: "2.0", id: 84, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" }, ...patch },
    }));
    assert.equal(r.error?.code, -32602, path);
    assert.equal(r.id, 84, path);
    assert.ok(r.error!.message.startsWith("Invalid params: " + path), path + ": the message names the path, got " + r.error!.message);
    // No schema-library JSON in the message: only words, dots, digits, brackets of a code name.
    assert.match(r.error!.message, /^[A-Za-z0-9 .:()_-]+$/, path + ": plain text");
    assert.doesNotMatch(r.error!.message, /expected|received/, path);
  }
});

test("P20c: control: every initialize that the SDK accepted is still accepted", async () => {
  // The accepted set must not move: each of these answered 200 with a result before the change.
  const accepted: [string, Record<string, unknown>][] = [
    ["empty capabilities", { capabilities: {}, clientInfo: { name: "x", version: "1" } }],
    ["roots, sampling and elicitation as objects", { capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} }, clientInfo: { name: "x", version: "1" } }],
    ["a full clientInfo with the right types", { capabilities: {}, clientInfo: { name: "x", version: "1", title: "X", description: "d", websiteUrl: "https://example.com/", icons: [{ src: "https://example.com/i.png" }] } }],
    ["an unknown capability key", { capabilities: { experimental: { feature: {} } }, clientInfo: { name: "x", version: "1" } }],
    ["an unknown extra params key", { capabilities: {}, clientInfo: { name: "x", version: "1" }, extra: 1 }],
    ["an unknown protocol version string", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } }],
  ];
  for (const [label, patch] of accepted) {
    const r = await readJson(await post({
      jsonrpc: "2.0", id: 85, method: "initialize",
      params: { protocolVersion: "2025-11-25", ...patch },
    }));
    assert.equal(r.error, undefined, label);
    assert.equal(r.id, 85, label);
    assert.equal(typeof r.result!.protocolVersion, "string", label);
  }
});

test("P21: errors the SDK answers on the 2026-07-28 lane carry no id field", async () => {
  // MCP-05: the SDK answers these with "id":null, which the 2026-07-28 revision does not allow.
  const bodies: [string, string][] = [
    ["an empty object", "{}"],
    ["null", "null"],
    ["a number", "42"],
    ["a null id", '{"jsonrpc":"2.0","id":null,"method":"tools/list"}'],
    ["an array id", '{"jsonrpc":"2.0","id":[],"method":"tools/list"}'],
    ["a numeric method", '{"jsonrpc":"2.0","id":1,"method":5}'],
  ];
  for (const [label, raw] of bodies) {
    const r = await post(raw, MODERN_LIST_HEADERS);
    assert.equal(r.status, 400, label);
    const text = await r.text();
    const length = r.headers.get("content-length");
    if (length !== null) assert.equal(Number(length), new TextEncoder().encode(text).length, label + ": Content-Length matches the rebuilt body");
    const body = JSON.parse(text) as Rpc;
    assert.equal(body.error!.code, -32600, label);
    assert.equal("id" in body, false, label + ": no id field");
  }
  for (const method of ["GET", "DELETE", "PUT"]) {
    const r = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method, headers: { "MCP-Protocol-Version": "2026-07-28" } }), {}, ctx);
    assert.equal(r.status, 405, method);
    const body = await r.json() as Rpc;
    assert.equal(body.error!.code, -32000, method);
    assert.equal("id" in body, false, method + ": no id field");
  }
  const evil = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "GET", headers: { "MCP-Protocol-Version": "2026-07-28", Origin: "https://evil.example" } }), {}, ctx);
  assert.equal(evil.status, 403);
  const evilBody = await evil.json() as Rpc;
  assert.equal(evilBody.error!.code, -32000);
  assert.match(evilBody.error!.message, /Invalid Origin/);
  assert.equal("id" in evilBody, false, "a disallowed Origin on the modern lane: no id field");
});

test("P21b: errors the Worker answers on the legacy lane carry id null, whatever the header", async () => {
  // MCP-06: the shared error helper left the id out on every lane. JSON-RPC 2.0 section 5 asks for
  // id null on a request whose id could not be read. No header, a legacy revision and an unknown
  // version are all the legacy lane.
  const legacyHeaders: Record<string, string>[] = [{}, { "MCP-Protocol-Version": "2025-06-18" }, { "MCP-Protocol-Version": "2099-01-01" }];
  const padded = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
  const valid = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  for (const h of legacyHeaders) {
    const where = JSON.stringify(h);
    const cases: [string, Response, number, number][] = [
      ["parse error", await post('{"jsonrpc":"2.0","id":"x","method":"tools/ca', h), 400, -32700],
      ["batch", await post([valid], h), 400, -32600],
      ["oversized body", await post(padded, h), 413, -32000],
      ["wrong media type", await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "POST", headers: { "Content-Type": "text/plain", ...h }, body: JSON.stringify(valid) }), {}, ctx), 415, -32000],
      ["disallowed Origin", await post(valid, { ...h, Origin: "https://evil.example" }), 403, -32000],
    ];
    for (const [label, r, status, code] of cases) {
      assert.equal(r.status, status, label + " " + where);
      const body = await r.json() as Rpc;
      assert.equal(body.error!.code, code, label + " " + where);
      assert.equal(body.id, null, label + " " + where + ": id null");
    }
  }
});

test("P21c: control: the other lane and the SDK's legacy answers keep their id shape", async () => {
  // The 2026-07-28 lane has no id on the Worker's own errors, the legacy SDK answers keep id null,
  // and the status and error code of every one stay as they were.
  const valid = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const padded = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
  const modernCases: [string, Response, number, number][] = [
    ["parse error", await post("{", MODERN_LIST_HEADERS), 400, -32700],
    ["batch", await post([valid], MODERN_LIST_HEADERS), 400, -32600],
    ["oversized body", await post(padded, MODERN_LIST_HEADERS), 413, -32000],
    ["disallowed Origin", await post(valid, { ...MODERN_LIST_HEADERS, Origin: "https://evil.example" }), 403, -32000],
  ];
  for (const [label, r, status, code] of modernCases) {
    assert.equal(r.status, status, label);
    const body = await r.json() as Rpc;
    assert.equal(body.error!.code, code, label);
    assert.equal("id" in body, false, label + ": no id field on the 2026-07-28 lane");
  }
  const sdkLegacy = await post("{}");
  assert.equal(sdkLegacy.status, 400);
  assert.equal(((await sdkLegacy.json()) as Rpc).id, null, "the SDK's legacy invalid request keeps id null");
  const get = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "GET" }), {}, ctx);
  assert.equal(get.status, 405);
  assert.equal(((await get.json()) as Rpc).id, null, "a GET without the header is legacy: id null");
  // A preflight carries no MCP-Protocol-Version header and is not a JSON-RPC request, so a
  // refused one is a legacy answer and reads id null.
  const preflight = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  }), {}, ctx);
  assert.equal(preflight.status, 403);
  const preflightBody = await preflight.json() as Rpc;
  assert.equal(preflightBody.error!.code, -32000);
  assert.equal(preflightBody.id, null, "a refused preflight reads id null");
});

test("P22: an Origin that is present but not a serialized origin is refused on every method", async () => {
  // MCP-09: the SDK parses the Origin as a URL and compares its hostname only, so a path, userinfo,
  // a fragment, a trailing slash or an empty value passed. A present Origin must equal the
  // serialized origin of its own parse. An empty value counts as present and malformed, the same
  // as the literal null; an absent header stays allowed.
  const valid = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const bad = ["https://turva.dev/path", "https://user@turva.dev", "https://turva.dev#fragment", "https://turva.dev/", "https://TURVA.DEV", ""];
  for (const origin of bad) {
    const label = JSON.stringify(origin);
    const postRequest = new Request("https://mcp.turva.dev/mcp", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(valid) });
    assert.equal(postRequest.headers.get("Origin"), origin, label + ": the header is present on the request");
    const r = await post(valid, { Origin: origin });
    assert.equal(r.status, 403, "POST " + label);
    const body = await r.json() as Rpc;
    assert.equal(body.error!.code, -32000, "POST " + label);
    assert.match(body.error!.message, /Invalid Origin/, "POST " + label);
    for (const method of ["OPTIONS", "GET", "DELETE"]) {
      const other = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method, headers: { Origin: origin } }), {}, ctx);
      assert.equal(other.status, 403, method + " " + label);
      await other.text();
    }
  }
});

test("P22c: control: the Origins that passed still pass, and the guard order is unchanged", async () => {
  // http://turva.dev and https://turva.dev:8443 are accepted on purpose (the comment on
  // MCP_ALLOWED_ORIGIN_HOSTNAMES). A missing header is a non-browser client.
  const valid = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  for (const origin of ["https://turva.dev", "http://turva.dev", "https://turva.dev:8443"]) {
    const r = await post(valid, { Origin: origin });
    assert.equal(r.status, 200, "POST " + origin);
    await r.text();
    const pre = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } }), {}, ctx);
    assert.equal(pre.status, 200, "OPTIONS " + origin);
    await pre.text();
  }
  const none = await post(valid);
  assert.equal(none.status, 200, "no Origin header");
  await none.text();
  for (const origin of ["https://evil.example", "null", "not-a-url"]) {
    const r = await post(valid, { Origin: origin });
    assert.equal(r.status, 403, origin);
    await r.text();
  }
  // A batch and an oversized body keep their 400 and 413 ahead of the Origin check (Tek-458 P7).
  const batch = await post([valid], { Origin: "https://turva.dev/path" });
  assert.equal(batch.status, 400, "a batch from a malformed Origin reads 400");
  await batch.text();
  const padded = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
  const big = await post(padded, { Origin: "" });
  assert.equal(big.status, 413, "an oversized body from a malformed Origin reads 413");
  await big.text();
});

test("P23: an accepted Origin on another scheme or port still gets Access-Control-Allow-Origin: https://turva.dev", async () => {
  // MCP-08: the hostname check accepts http://turva.dev and https://turva.dev:8443, but the
  // response always names https://turva.dev, so a browser page on either passes this endpoint's
  // check and is then refused by the browser's own CORS check. README says so.
  for (const origin of ["http://turva.dev", "https://turva.dev:8443", "https://turva.dev"]) {
    const pre = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } }), {}, ctx);
    assert.equal(pre.status, 200, origin);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://turva.dev", origin);
    await pre.text();
  }
});
