import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { SERVICES, AGENT_READINESS, SECURITY_EVIDENCE, PRINCIPLES, CONTACT, NO_ARGUMENT_TOOL_NAMES } from "../src/index.ts";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";

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
  // The raw __proto__ guard (P13) must not catch an ordinary extra key: that one stays with
  // the SDK's own schema check and its own message.
  assert.doesNotMatch(res.content[0].text, /unrecognized key\(s\) in object/);
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
    // T-02 (Astra audit 2026-09-26): the 2026-07-28 revision's JSONRPCErrorResponse allows
    // id to be a string, a number, or absent, never null; this rejection cannot know the
    // id of a batch's individual messages, so it now omits the field instead of sending null.
    assert.equal(body.id, undefined, label);
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

test("P12: malformed initialize and tools/list params are refused as Invalid params, not Internal error", async () => {
  // Astra audit 2026-09-26, T-01/F-01: the SDK's own schema validation for these two
  // methods threw a plain Error on a malformed shape, which its catch defaulted to
  // -32603 Internal error instead of -32602 Invalid params.
  const missingParams = await readJson(await post({ jsonrpc: "2.0", id: 27, method: "initialize" }));
  assert.equal(missingParams.error.code, -32602, "initialize with no params at all");
  assert.equal(missingParams.id, 27);
  const missingCapabilities = await readJson(await post({
    jsonrpc: "2.0", id: 28, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(missingCapabilities.error.code, -32602, "initialize with no capabilities");
  const badVersionType = await readJson(await post({
    jsonrpc: "2.0", id: 32, method: "initialize",
    params: { protocolVersion: 42, capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(badVersionType.error.code, -32602, "initialize with a numeric protocolVersion");
  const cursorNumber = await readJson(await post(
    { jsonrpc: "2.0", id: 7, method: "tools/list", params: { cursor: 123, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
  ));
  assert.equal(cursorNumber.error.code, -32602, "tools/list with a numeric cursor");
  assert.equal(cursorNumber.id, 7);
  // The check answers only the malformed shapes above; a well-formed initialize still works.
  const stillWorks = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(stillWorks.error, undefined, "a well-formed initialize is unaffected");
});

test("P13: a raw __proto__ argument key is refused the same way any other extra key is", async () => {
  // Astra audit 2026-09-26, T-04: an object literal spread drops "__proto__" as an own key,
  // but JSON.parse keeps it as a real own property, so a raw JSON body can carry what an
  // object literal in this test file cannot: the body below is built as a literal string,
  // not an object literal, so the key survives into the request the same way it did in the
  // audit's own reproduction.
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const r = await post(raw, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_contact" });
  const body = await readJson(r);
  assert.equal(body.id, 42);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /Input validation error/);
  // W16 F1: the 2026-07-28 lane carries resultType on this hand-built result too.
  assert.equal(body.result.resultType, "complete");
  // The legacy lane keeps its earlier bytes: no resultType.
  const legacy = await readJson(await post(raw));
  assert.equal(legacy.result.isError, true);
  assert.equal(legacy.result.resultType, undefined);
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
  const reader = r.body.getReader();
  const chunks = [];
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
  const badCursorBody = await badCursor.json();
  assert.equal(badCursorBody.error.code, -32000);
  assert.equal(badCursorBody.id, undefined, "B2: no id field, never null");
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const protoFromEvil = await post(raw, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_contact", ...evilOrigin });
  assert.equal(protoFromEvil.status, 403, "a raw __proto__ key from a disallowed Origin");
  assert.equal((await protoFromEvil.json()).id, undefined, "B2: no id field, never null");
  // do-not-fix line 225 (Tek-458 P7): a batch and an oversized body still answer 400
  // and 413 before Origin is even considered, unchanged by B1.
  const batchFromEvil = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], evilOrigin);
  assert.equal(batchFromEvil.status, 400, "a batch from a disallowed Origin still reads 400, not 403");
  await batchFromEvil.text();
  const padded = (n) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(n) } });
  const oversizeFromEvil = await post(padded(70_000), evilOrigin);
  assert.equal(oversizeFromEvil.status, 413, "an oversized body from a disallowed Origin still reads 413, not 403");
  await oversizeFromEvil.text();
  // A well-formed request from the same Origin still reads the plain 403, unaffected.
  const plain = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, evilOrigin);
  assert.equal(plain.status, 403, "a well-formed request from the same Origin");
  await plain.text();
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
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "turva varmennus proba lause", arguments: {}, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "turva varmennus proba lause" },
  ));
  assert.equal(short.error.code, -32602);
  assert.equal(short.id, 3);
  assert.doesNotMatch(short.error.message, /turva varmennus proba lause/, "the name is not spliced into the message text");
  assert.equal(short.error.data.tool.name, "turva varmennus proba lause");
  assert.equal(short.error.data.tool.truncated, false);
  const longName = "x".repeat(200);
  const long = await readJson(await post(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: longName, arguments: {}, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": longName },
  ));
  assert.equal(long.error.data.tool.name.length, 64, "the echoed name is capped at 64 characters");
  assert.equal(long.error.data.tool.truncated, true);
  assert.doesNotMatch(JSON.stringify(long), new RegExp(longName), "the full 200-character name never appears anywhere in the response");
  // A known tool name is unaffected.
  const known = await call("tools/call", { name: "get_contact" });
  assert.notEqual(known.isError, true);
});

test("P17: a disallowed Origin is refused with the same no-id shape when Content-Type is not JSON", async () => {
  // V02-2 (Astra audit 2026-09-28, 3rd round): the JSON-Content-Type path already answers a
  // disallowed Origin without an id field (P15 above), but a POST whose Content-Type is not
  // JSON used to skip guardMcpPost's own Origin check entirely and reach the SDK's own check,
  // which still answers with a literal "id":null. This checks the non-JSON path now matches.
  const r = await worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  }), {}, ctx);
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.error.code, -32000);
  assert.match(body.error.message, /Invalid Origin/);
  assert.equal(body.id, undefined, "no id field, never null");
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

test("P17b: a JSON body that does not parse is answered by the Worker with 400 and no id field", async () => {
  // W16 U1 (ChatGPT review 2026-10-02): the SDK answers a parse error with "id":null, which the
  // 2026-07-28 revision does not allow, so the Worker answers it itself, with and without the
  // modern headers, and the id field is absent rather than null.
  const cut = '{"jsonrpc":"2.0","id":"x","method":"tools/ca';
  for (const headers of [{}, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" }]) {
    const r = await post(cut, headers);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, -32700);
    assert.equal(body.error.message, "Parse error: Invalid JSON");
    assert.equal("id" in body, false, "no id field, never null");
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
  assert.equal(badClientInfoType.error.code, -32602, "clientInfo as a string");
  assert.equal(badClientInfoType.id, 31);
  const missingClientInfo = await readJson(await post({
    jsonrpc: "2.0", id: 33, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {} },
  }));
  assert.equal(missingClientInfo.error.code, -32602, "clientInfo missing entirely");
  const badNameType = await readJson(await post({
    jsonrpc: "2.0", id: 34, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: 1, version: "1.0" } },
  }));
  assert.equal(badNameType.error.code, -32602, "clientInfo.name not a string");
  const badVersionType = await readJson(await post({
    jsonrpc: "2.0", id: 35, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "x", version: 1 } },
  }));
  assert.equal(badVersionType.error.code, -32602, "clientInfo.version not a string");
  // A well-formed initialize is unaffected.
  const stillWorks = await readJson(await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol.test", version: "0" } },
  }));
  assert.equal(stillWorks.error, undefined, "a well-formed initialize is unaffected");
});
