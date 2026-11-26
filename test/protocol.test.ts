import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { SERVICES, AGENT_READINESS, SECURITY_EVIDENCE, PRINCIPLES, CONTACT, NO_ARGUMENT_TOOL_NAMES, TOOL_NAMES, closeListenStreamAfterAck, pageUrlFor, parsePageIndex } from "../src/index.ts";
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
// The five tools above return compiled-in data and take no arguments. get_page_index (Tek-915) takes no arguments
// either and get_page (Tek-908) takes a path, and both read the site, so they are listed beside them and tested on
// their own below.
const ALL_TOOLS = [...Object.keys(TOOLS), "get_page_index", "get_page"];
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
  for (const name of ALL_TOOLS) {
    assert.match(d.instructions, new RegExp("\\b" + name + "\\b"), "the instructions route to " + name);
  }
  assert.match(d.instructions, /A general question about what turva\.dev does starts there too\./, "the instructions give the general question the same home as the get_services description");
});

test("P2: subscriptions/listen acknowledges no tools filter, because none can fire", async () => {
  const r = await post(
    { jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen" },
  );
  assert.equal(r.status, 200);
  // The stream closes itself right after the acknowledgement (see P14), so that first event is the whole answer.
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const line = new TextDecoder().decode(value).split(/\r?\n/).find((l) => l.startsWith("data:"));
  const ack = JSON.parse(line!.slice(5));
  assert.equal(ack.method, "notifications/subscriptions/acknowledged");
  assert.deepEqual(ack.params.notifications, {});
});

test("P3: tools/list declares seven read-only tools, six that take no arguments and get_page that takes a path, and describes their output", async () => {
  const { tools } = await call("tools/list") as { tools: Tool[] };
  assert.deepEqual(tools.map((t) => t.name), ALL_TOOLS);
  const page = tools.find((t) => t.name === "get_page")! as Tool & { description: string; inputSchema: { required?: string[]; properties: Record<string, { type?: string; maxLength?: number }> } };
  assert.deepEqual(Object.keys(page.inputSchema.properties), ["path"]);
  assert.equal(page.inputSchema.properties.path!.type, "string");
  assert.equal(page.inputSchema.properties.path!.maxLength, 512);
  assert.deepEqual(page.inputSchema.required, ["path"]);
  assert.equal(page.inputSchema.additionalProperties, false, "get_page names its one argument and refuses others");
  assert.deepEqual(Object.keys(page.outputSchema!.properties), ["path", "status", "content_type", "markdown", "bytes"]);
  assert.equal(page.outputSchema!.additionalProperties, false);
  assert.match(page.description, /text\/markdown/, "the description says what the page text is");
  assert.match(page.description, /262144 bytes/, "the description names the cap the code applies");
  assert.match(page.description, /does not follow a redirect/);
  assert.match(page.description, /not the HTML page byte for byte/, "it does not claim byte equality with the HTML page");
  for (const t of tools) {
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    if (t.name === "get_page") continue;
    assert.deepEqual(t.inputSchema.properties, {}, t.name + " takes no arguments");
    assert.equal(t.inputSchema.additionalProperties, false, t.name + " says it takes no arguments");
    assert.equal(t.outputSchema?.type, "object", t.name + " describes its output");
    assert.equal(t.outputSchema!.additionalProperties, false, t.name + " names every field it returns");
    if (t.name === "get_page_index") continue;
    assert.deepEqual(Object.keys(t.outputSchema!.properties).sort(), Object.keys(TOOLS[t.name as keyof typeof TOOLS]).sort(), t.name + " schema and data name the same fields");
  }
  // Tek-915: get_page_index takes no arguments, names the four fields it returns, describes every field at every level,
  // and says in its description when to use it and when to use get_page instead.
  const index = tools.find((t) => t.name === "get_page_index")! as Tool & { description: string };
  assert.deepEqual(Object.keys(index.outputSchema!.properties), ["source", "count", "skipped_links", "sections"]);
  const undescribed = (schema: any, path: string): string[] => {
    const found: string[] = [];
    for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) {
      if (typeof sub.description !== "string" || sub.description === "") found.push(path + key);
      found.push(...undescribed(sub, path + key + "."), ...(sub.items ? undescribed(sub.items, path + key + "[].") : []));
    }
    return found;
  };
  assert.deepEqual(undescribed(index.outputSchema, ""), [], "every output field of get_page_index carries a description");
  assert.match(index.description, /\/llms\.txt/, "the description names the index it reads");
  assert.match(index.description, /get_page\b/, "the description hands a page read over to get_page");
  assert.match(index.description, /get_services/, "the description hands the services over to get_services");
  assert.match(index.description, /does not follow a redirect/);
  assert.match(page.description, /get_page_index/, "get_page points to get_page_index to find the paths");
  assert.doesNotMatch(page.description + " " + (page.inputSchema.properties.path as { description?: string }).description, /Call get_page with \/llms\.txt to list/, "the old way of finding paths is not the advice");
  // 1.15.2: the empty input schema already says a zero-argument tool takes no arguments, so no description repeats it, and the three
  // tools that state no behaviour of their own say that they make no network request and return the same data on every call.
  const described = tools as Array<Tool & { description: string }>;
  for (const t of described) {
    if (t.name === "get_page") continue;
    assert.doesNotMatch(t.description, /Takes no arguments/, t.name + " does not restate its empty input schema");
  }
  for (const name of ["get_security_evidence", "get_principles", "get_contact"]) {
    const d = described.find((t) => t.name === name)!.description;
    assert.match(d, /makes no network request/, name + " says it makes no network request");
    assert.match(d, /same on every call/, name + " says its data is the same on every call");
  }
  assert.match(described.find((t) => t.name === "get_services")!.description, /in general what turva\.dev does/, "get_services is the home of the general question");
  // 1.15.3: the example in get_principles names the policy the way the page does, not the unclear "no calls".
  const principles = described.find((t) => t.name === "get_principles")!.description;
  assert.match(principles, /runs in writing, with no calls and no calendar links/, "get_principles says what an engagement without calls means");
  assert.doesNotMatch(principles, /why there are no calls/, "the unclear old example is gone");
  assert.match(described.find((t) => t.name === "get_security_evidence")!.description, /runs no scan/, "get_security_evidence says a call runs no scan");
  assert.match(described.find((t) => t.name === "get_contact")!.description, /sends no message for the user/, "get_contact says a call sends no message");
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

// Tek-784: the quoted add-on travels over the wire, not only in the compiled constant. P4 compares the whole
// object with SERVICES; this one names the fields a client reads, so a dropped list fails by name.
test("P4b: get_services returns active security testing as a quoted add-on that needs the audit", async () => {
  const res = await call("tools/call", { name: "get_services", arguments: {} });
  assert.notEqual(res.isError, true);
  const sc = res.structuredContent as { quoted_add_ons?: Array<Record<string, unknown>> };
  assert.equal(sc.quoted_add_ons?.length, 1);
  const a = sc.quoted_add_ons![0]!;
  assert.equal(a.name, "Active security testing");
  assert.equal(a.price, "on request");
  assert.equal(a.requires, "audit");
  assert.equal(a.sold_separately, false);
  assert.equal(a.url, "https://turva.dev/services#active-security-testing");
});

// Tek-886: the contract terms, the sample report and the privacy notice travel over the wire, and the tool descriptions
// name the fields that carry them, so a client that reads only tools/list learns where the answer is.
test("P4c: get_services returns contract_terms and sample_report, get_contact returns privacy, and the descriptions route between the tools", async () => {
  const s = await call("tools/call", { name: "get_services", arguments: {} });
  assert.notEqual(s.isError, true);
  const sc = s.structuredContent as { contract_terms?: Record<string, unknown>; sample_report?: Record<string, unknown> };
  assert.equal(sc.contract_terms?.url, "https://turva.dev/legal");
  assert.equal(sc.sample_report?.url, "https://turva.dev/samples/audit-report");
  assert.equal(sc.sample_report?.fictional, true);
  assert.equal((sc.sample_report?.example_findings as string[]).length, 9);
  const c = await call("tools/call", { name: "get_contact", arguments: {} });
  assert.notEqual(c.isError, true);
  const privacy = (c.structuredContent as { privacy?: Record<string, unknown> }).privacy;
  assert.equal(privacy?.url, "https://turva.dev/legal");
  assert.ok(Array.isArray(privacy?.cookies) && privacy.cookies.length > 0);
  const { tools } = await call("tools/list") as { tools: Array<Tool & { description?: string }> };
  const text = (n: string) => tools.find((t) => t.name === n)!.description!;
  assert.match(text("get_services"), /get_principles/, "get_services routes the principles to get_principles");
  assert.match(text("get_services"), /get_contact/, "get_services routes the operator and privacy questions to get_contact");
  assert.match(text("get_contact"), /privacy sections of the legal page/, "get_contact says it quotes the privacy sections of the legal page");
  assert.match(text("get_contact"), /get_services/, "get_contact routes the services and terms to get_services");
  assert.doesNotMatch(text("get_contact"), /left out/, "get_contact no longer says a privacy section is left out");
  assert.match(text("get_agent_readiness"), /get_security_evidence/, "the two proof tools point at each other");
  assert.match(text("get_security_evidence"), /get_agent_readiness/, "the two proof tools point at each other");
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
  assert.deepEqual(list.result!.tools.map((t: Tool) => t.name), ALL_TOOLS);
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
  assert.deepEqual(single.result!.tools.map((t: Tool) => t.name), ALL_TOOLS);
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
  // NO_ARGUMENT_TOOL_NAMES is exactly the six argumentless tools, and TOOL_NAMES, which the unknown-tool check reads, is every tool.
  assert.deepEqual([...NO_ARGUMENT_TOOL_NAMES].sort(), [...Object.keys(TOOLS), "get_page_index"].sort());
  assert.deepEqual([...TOOL_NAMES], ALL_TOOLS);
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
  // B1 (Astra audit 2026-09-28): T-01 and T-04 (P12, P13
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
  // C3 finding 2: the 2026-07-28 lane answers a transport refusal with -32600 (P29).
  assert.equal(badCursorBody.error!.code, -32600);
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
  // Astra audit 2026-09-28, 3rd round: the JSON-Content-Type path already answers a
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
  // the Worker answers 415 for the wrong Content-Type (see P17c), not a 403.
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
    // C3 finding 2: -32600 on the 2026-07-28 lane, the SDK's -32000 on the legacy lane (P29).
    assert.equal(wrongTypeBody.error!.code, lane === "current" ? -32600 : -32000, lane);
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
  // Astra audit 2026-09-28, 3rd round: invalidParamsReason checked
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
    // C3 finding 5 moved "a numeric method" with id 1 out of this list: its id can be read, so
    // the Worker now answers it with that id (P30).
    ["a numeric method and no id", '{"jsonrpc":"2.0","method":5}'],
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
    // C3 finding 2: the SDK's -32000 becomes -32600 on this lane (P29).
    assert.equal(body.error!.code, -32600, method);
    assert.equal("id" in body, false, method + ": no id field");
  }
  const evil = await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "GET", headers: { "MCP-Protocol-Version": "2026-07-28", Origin: "https://evil.example" } }), {}, ctx);
  assert.equal(evil.status, 403);
  const evilBody = await evil.json() as Rpc;
  assert.equal(evilBody.error!.code, -32600);
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
    // C3 finding 2: the 2026-07-28 lane uses -32600 for these (P29); the legacy cases below keep -32000.
    ["oversized body", await post(padded, MODERN_LIST_HEADERS), 413, -32600],
    ["disallowed Origin", await post(valid, { ...MODERN_LIST_HEADERS, Origin: "https://evil.example" }), 403, -32600],
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

// A roughly 5 000 level deep
// capabilities.experimental, 30 kB and so under the 64 KiB cap, used to pass the guard and make
// the SDK's schema library overflow the stack: a 400 whose data field named RangeError, plus an
// unhandled promise rejection. The guard now refuses params nested more than 64 levels, counting
// params itself as level 1, before any schema runs. 64 is far above what a client sends
// (capabilities, _meta and clientInfo nest 3 to 5 levels) and far below the 1 000 levels where
// the overflow starts, so the refusal never meets a real client.
function nestedObjects(depth: number): string {
  return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
}
const initializeWithExperimental = (depth: number) => `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":${nestedObjects(depth)}},"clientInfo":{"name":"x","version":"1"}}}`;

test("P24: a deeply nested initialize is refused as Invalid params, with no internal error name and no unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    const deep = await post(initializeWithExperimental(5000));
    const text = await deep.text();
    assert.equal(deep.status, 200, "answered like every other Invalid params");
    const body = JSON.parse(text) as Rpc;
    assert.equal(body.error?.code, -32602);
    assert.equal(body.id, 1);
    assert.match(body.error!.message, /^Invalid params: /);
    assert.doesNotMatch(text, /RangeError|call stack|Parse error/, "nothing internal in the body");
    assert.equal((body.error as { data?: unknown }).data, undefined, "no data field");
    // The overflow, when it happens, surfaces on a later turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.equal(rejections.length, 0, "no unhandled promise rejection is left behind: " + String(rejections[0]));
});

test("P24b: control: nesting up to the limit is accepted exactly as before, one level more is not", async () => {
  // params is level 1, capabilities 2, experimental 3, so 62 nested objects below it reach 64.
  // A depth of 1 is {"a":1}, which the SDK schema itself refuses (experimental holds objects),
  // so the accepted range starts at 2.
  for (const depth of [2, 5, 30, 62]) {
    const ok = await readJson(await post(initializeWithExperimental(depth)));
    assert.equal(ok.error, undefined, "depth " + depth + " is accepted");
    assert.equal(typeof ok.result!.protocolVersion, "string", "depth " + depth);
  }
  const over = await readJson(await post(initializeWithExperimental(63)));
  assert.equal(over.error?.code, -32602, "level 65 is refused");
  // Deep nesting in another capability that the SDK schema ignores is refused the same way.
  const roots = await readJson(await post(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":${nestedObjects(500)}},"clientInfo":{"name":"x","version":"1"}}}`));
  assert.equal(roots.error?.code, -32602, "deep roots is refused too");
  // Arrays count as levels as well.
  const arrays = await readJson(await post(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"c","x":${"[".repeat(200)}${"]".repeat(200)}}}`));
  assert.equal(arrays.error?.code, -32602, "deep arrays are refused too");
  // A deep value that is not nested params (a long flat array) is not a depth problem.
  const flat = await readJson(await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { x: Array.from({ length: 5000 }, () => 1) } }));
  assert.equal(flat.error, undefined, "a flat array of 5 000 numbers is accepted");
});

test("P24c: the same depth limit covers a body without an id: a clean 400, no internal error name, no unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    const deepInit = `{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":${nestedObjects(5000)}},"clientInfo":{"name":"x","version":"1"}}}`;
    const deepCall = `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_contact","arguments":{"x":${nestedObjects(5000)}}}}`;
    const deepNotice = `{"jsonrpc":"2.0","method":"notifications/initialized","params":{"x":${nestedObjects(5000)}}}`;
    for (const [label, raw] of [["initialize", deepInit], ["tools/call", deepCall], ["notifications/initialized", deepNotice]]) {
      const res = await post(raw);
      const text = await res.text();
      assert.equal(res.status, 400, label);
      const body = JSON.parse(text) as Rpc;
      assert.equal(body.error?.code, -32600, label);
      assert.equal(body.id, null, label);
      assert.equal(body.error!.message, "Invalid Request: params are nested more than 64 levels deep", label);
      assert.equal((body.error as { data?: unknown }).data, undefined, label + ": no data field");
      assert.doesNotMatch(text, /RangeError|call stack|Parse error/, label);
    }
    // On the 2026-07-28 lane the refusal leaves the id member out, as every other error there does.
    const modern = await post(deepNotice, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "notifications/initialized" });
    const modernText = await modern.text();
    assert.equal(modern.status, 400, "2026-07-28 lane");
    assert.equal(Object.hasOwn(JSON.parse(modernText) as object, "id"), false, "2026-07-28 lane: no id member");
    assert.equal((JSON.parse(modernText) as Rpc).error?.code, -32600, "2026-07-28 lane");
    assert.doesNotMatch(modernText, /RangeError|call stack|Parse error/, "2026-07-28 lane");
    // Exactly 64 levels deep without an id behaves as before: a notification is accepted.
    const ok = await post(`{"jsonrpc":"2.0","method":"notifications/initialized","params":{"x":${nestedObjects(62)}}}`);
    assert.equal(ok.status, 202, "64 levels deep, no id: accepted as before");
    await ok.text();
    const plain = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(plain.status, 202, "an ordinary notification keeps its answer");
    await plain.text();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.equal(rejections.length, 0, "no unhandled promise rejection is left behind: " + String(rejections[0]));
});

// The relay branch of closeListenStreamAfterAck had no
// cancel hook, so a downstream cancel never reached the SDK's stream. The pinned SDK 2.4.0 never
// takes this branch with a stream that stays open (its first chunk is always the
// acknowledgement and the 2025-era lane ends by itself), so this is insurance for an SDK update.
// What this test proves: in isolation, with an upstream of its own that never ends and whose
// first chunk is not the acknowledgement, cancelling the downstream reader cancels the upstream.
// What it does not prove: that the SDK can reach this branch, or how workerd treats a cancel.
test("P25: a downstream cancel on the relay branch reaches the upstream stream", async () => {
  let upstreamCancelled = false;
  let upstreamReason: unknown;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); },
    cancel(reason) { upstreamCancelled = true; upstreamReason = reason; },
  });
  const res = new Response(upstream, { headers: { "Content-Type": "text/event-stream" } });
  const relayed = closeListenStreamAfterAck(res, 7);
  const reader = relayed.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), ": keepalive\n\n", "the first chunk is relayed unchanged");
  await reader.cancel("client went away");
  for (let i = 0; i < 20 && !upstreamCancelled; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(upstreamCancelled, true, "the upstream was cancelled");
  assert.equal(upstreamReason, "client went away", "with the downstream's reason");
});

// The echo limits of the tool name and the argument keys (64 characters) now also cover the
// Origin refusal text (the whole message is at most 96 characters) and the path of an
// initialize issue. Not capped, and not covered here: the SDK's own protocol-version messages
// and a string request id, which are echoed as sent.
test("P26: the Origin and the initialize issue path are echoed only up to a limit", async () => {
  const valid = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const long = "https://turva.dev/" + "p".repeat(5000);
  for (const origin of [long, "x".repeat(5000), "https://" + "h".repeat(200) + ".example"]) {
    const r = await post(valid, { Origin: origin });
    assert.equal(r.status, 403, "still refused");
    const text = await r.text();
    const message = (JSON.parse(text) as Rpc).error!.message;
    assert.match(message, /^Invalid Origin/);
    assert.equal(message.length, 99, "the message is cut at 96 characters plus the ellipsis, got " + message.length);
    assert.ok(message.endsWith("..."), "and ends in the ellipsis");
    assert.ok(text.length < 400, "and so is the whole body, got " + text.length);
  }
  // Short Origins keep the exact message they had.
  const short = await post(valid, { Origin: "https://evil.example" });
  assert.equal(((await short.json()) as Rpc).error!.message, "Invalid Origin: evil.example");
  const shortBad = await post(valid, { Origin: "https://turva.dev/path" });
  assert.equal(((await shortBad.json()) as Rpc).error!.message, "Invalid Origin header: https://turva.dev/path");
  // The issue path of an initialize: a 2 000 character key under capabilities.experimental.
  const key = "K".repeat(2000);
  const r = await readJson(await post({
    jsonrpc: "2.0", id: 9, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: { experimental: { [key]: 1 } }, clientInfo: { name: "x", version: "1" } },
  }));
  assert.equal(r.error?.code, -32602);
  assert.ok(r.error!.message.length < 200, "the message is short, got " + r.error!.message.length);
  assert.ok(r.error!.message.startsWith("Invalid params: params.capabilities.experimental."), r.error!.message);
  assert.doesNotMatch(r.error!.message, /K{65}/, "no key longer than 64 characters comes back");
  // A key within the limit still comes back whole, as P20 expects of the path.
  const ok64 = await readJson(await post({
    jsonrpc: "2.0", id: 10, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: { experimental: { ["k".repeat(64)]: 1 } }, clientInfo: { name: "x", version: "1" } },
  }));
  assert.ok(ok64.error!.message.includes("k".repeat(64)), "a 64 character key is echoed whole");
});

// Deployment and repository hygiene: these read files and assert what they must keep saying.
test("P27: deployment and repository hygiene: no preview URLs, a named rate-limit binding, a bounded CI job, no credential files committed", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const conf = read("../wrangler.jsonc");
  assert.match(conf, /^\s*"workers_dev":\s*false,/m, "workers_dev stays off");
  assert.match(conf, /^\s*"preview_urls":\s*false,/m, "preview URLs are off, so no <version>-turva-mcp.<subdomain>.workers.dev");
  // The limiter is optional in code and fails open on purpose (see the README), so a
  // renamed binding would switch it off without any failing test. The name in the Env interface
  // must be the name wrangler.jsonc declares.
  const bindingName = /interface Env \{\s*(\w+)\?:/.exec(read("../src/index.ts"))?.[1];
  assert.equal(bindingName, "RATE_LIMITER");
  const declares = (config: string, name: string) => new RegExp(`"name":\\s*"${name}"`).test(config);
  assert.ok(declares(conf, bindingName), "wrangler.jsonc declares the binding the code reads");
  // Tek-908: get_page reads the site through a service binding, and the code's name for it must be the name wrangler.jsonc declares.
  assert.match(read("../src/index.ts"), /interface Env \{[^}]*\bSITE\?: SiteBinding;/);
  assert.match(conf, /"services":\s*\[\s*\{\s*"binding":\s*"SITE",\s*"service":\s*"turva-worker"\s*\}\s*\]/, "wrangler.jsonc binds SITE to the turva-worker Worker");
  assert.doesNotMatch(read("../src/index.ts").replace(/\/\/.*$/gm, ""), /\bfetch\(\s*["'`]/, "no code path calls the global fetch with a URL of its own");
  assert.ok(!declares(conf.replace('"RATE_LIMITER"', '"RATE_LIMITER_RENAMED"'), bindingName), "the check does fail on a rename");
  // The CI job neither keeps the checkout token nor runs without a time limit.
  const ci = read("../.github/workflows/ci.yml");
  assert.match(ci, /^\s+persist-credentials:\s*false\s*$/m, "checkout does not leave the token in .git/config");
  assert.match(ci, /^\s+timeout-minutes:\s*\d+\s*$/m, "the job has a time limit");
  // Registry tokens and key material stay out of the repository.
  const ignored = read("../.gitignore").split(/\r?\n/).map((line) => line.trim());
  for (const pattern of [".npmrc", "*.pem", "*.key", "credentials.json"]) {
    assert.ok(ignored.includes(pattern), ".gitignore lists " + pattern);
  }
  // The deploy steps tell the reader to install from the lockfile.
  const readme = read("../README.md");
  const deploy = readme.slice(readme.indexOf("## Deploy your own copy"), readme.indexOf("## Maintainer"));
  assert.ok(deploy.includes("npm ci"), "the deploy-your-own-copy steps say to run npm ci");
});

// C3 (MCP protocol test of mcp.turva.dev 1.13.0, 2026-11-22): the five low deviations a
// verifier confirmed against the source and the 2026-07-28 schema, and finding 13 as a proposal.
const MODERN_CALL_HEADERS = (name?: string): Record<string, string> => ({
  "MCP-Protocol-Version": "2026-07-28",
  "Mcp-Method": "tools/call",
  ...(name === undefined ? {} : { "Mcp-Name": name }),
});

test("P28: on the 2026-07-28 lane an error carries no id that the revision's RequestId does not allow", async () => {
  // C3 finding 1: the SDK answered id 1.5 with "id":1.5, and the 2026-07-28 schema's RequestId is a
  // string or an integer. The filter of SDK answers on that lane (withoutNullId, now
  // modernLaneAnswer) took out only a null id.
  const envelope = '"method":"tools/list","params":{"_meta":' + JSON.stringify(META) + '}}';
  const cases: [string, string][] = [
    ["a fractional id", '{"jsonrpc":"2.0","id":1.5,' + envelope],
    ["an id beyond the safe integers", '{"jsonrpc":"2.0","id":1e30,' + envelope],
    ["a boolean id", '{"jsonrpc":"2.0","id":true,' + envelope],
    ["a fractional id and no method", '{"jsonrpc":"2.0","id":1.5}'],
  ];
  for (const [label, raw] of cases) {
    const r = await post(raw, MODERN_LIST_HEADERS);
    assert.equal(r.status, 400, label);
    const text = await r.text();
    const length = r.headers.get("content-length");
    if (length !== null) assert.equal(Number(length), new TextEncoder().encode(text).length, label + ": Content-Length matches the rebuilt body");
    const body = JSON.parse(text) as Rpc;
    assert.equal(body.error!.code, -32600, label);
    assert.equal("id" in body, false, label + ": no id field");
  }
  // Control: the legacy lane keeps the SDK's answer, and JSON-RPC 2.0 allows a number id there.
  const legacy = await post({ jsonrpc: "2.0", id: 1.5, method: "tools/list" });
  assert.equal(legacy.status, 400);
  assert.equal(((await legacy.json()) as Rpc).id, 1.5, "legacy lane: the SDK's echo is kept");
  // Control: a string id and an integer id are still echoed on the 2026-07-28 lane.
  for (const id of ["abc", 7]) {
    const ok = await readJson(await post({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: META } }, MODERN_LIST_HEADERS));
    assert.equal(ok.id, id, String(id));
    assert.ok(ok.result, String(id) + ": a result");
  }
});

test("P29: transport refusals use -32600 on the 2026-07-28 lane and keep -32000 on the legacy lane", async () => {
  // C3 finding 2: MCP 2026-07-28 marks -32000 to -32019 as a legacy sub-range that new
  // implementations SHOULD NOT use, and -32020 to -32099 holds only the codes the specification
  // defines. The HTTP status keeps naming the reason.
  const valid = (modern: boolean) => ({ jsonrpc: "2.0", id: 1, method: "tools/list", ...(modern ? { params: { _meta: META } } : {}) });
  const padded = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
  const lanes: [string, Record<string, string>, boolean, number][] = [
    ["2026-07-28", MODERN_LIST_HEADERS, true, -32600],
    ["legacy", {}, false, -32000],
  ];
  for (const [lane, headers, modern, code] of lanes) {
    const evil = { ...headers, Origin: "https://evil.example" };
    const answers: [string, Response, number][] = [
      ["an oversized body", await post(padded, headers), 413],
      ["a Content-Length over the limit", await post("{}", { ...headers, "Content-Length": "70000" }), 413],
      ["a disallowed Origin", await post(valid(modern), evil), 403],
      ["a disallowed Origin and a body that does not parse", await post("{", evil), 403],
      ["a body not declared as JSON", await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "POST", headers: { "Content-Type": "text/plain", ...headers }, body: JSON.stringify(valid(modern)) }), {}, ctx), 415],
      ["a GET", await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "GET", headers }), {}, ctx), 405],
      ["a GET from a disallowed Origin", await worker.fetch(new Request("https://mcp.turva.dev/mcp", { method: "GET", headers: evil }), {}, ctx), 403],
    ];
    for (const [label, r, status] of answers) {
      assert.equal(r.status, status, `${lane}: ${label}`);
      const body = await r.json() as Rpc;
      assert.equal(body.error!.code, code, `${lane}: ${label}`);
    }
  }
  // Control: the codes the specification defines on the 2026-07-28 lane are untouched.
  const missingHeader = await post({ jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: META } }, { "Mcp-Method": "tools/list" });
  assert.equal(missingHeader.status, 400);
  assert.equal(((await missingHeader.json()) as Rpc).error!.code, -32020, "HeaderMismatch stays -32020");
});

test("P30: a request with a missing or non-string method keeps its readable id in the error, on both lanes", async () => {
  // C3 finding 5: FM19 (no method) and FM20 (method 42) were answered without the readable ids
  // 319 and 320, while a missing jsonrpc (FM17) and jsonrpc 1.0 (FM18) kept theirs.
  const bodies: [string, Record<string, unknown>, string | number][] = [
    ["no method", { jsonrpc: "2.0", id: 319 }, 319],
    ["a numeric method", { jsonrpc: "2.0", id: 320, method: 42 }, 320],
    ["a null method and a string id", { jsonrpc: "2.0", id: "x", method: null }, "x"],
    ["no jsonrpc and no method", { id: 321 }, 321],
  ];
  const lanes: [string, Record<string, string>, boolean][] = [["2026-07-28", MODERN_LIST_HEADERS, true], ["legacy", {}, false]];
  for (const [lane, headers, modern] of lanes) {
    const params = modern ? { params: { _meta: META } } : {};
    for (const [label, body, id] of bodies) {
      const r = await post({ ...body, ...params }, headers);
      assert.equal(r.status, 400, `${lane}: ${label}`);
      const parsed = await r.json() as Rpc;
      assert.equal(parsed.error!.code, -32600, `${lane}: ${label}`);
      assert.equal(parsed.error!.message, "Bad Request: the request body is not a valid JSON-RPC message", `${lane}: ${label}`);
      assert.equal(parsed.id, id, `${lane}: ${label}: the id is echoed`);
    }
    // Control: FM17 and FM18, which the SDK already answered with the id, keep that answer.
    for (const body of [{ id: 317, method: "tools/list", ...params }, { jsonrpc: "1.0", id: 318, method: "tools/list", ...params }]) {
      const r = await post(body, headers);
      assert.equal(r.status, 400, `${lane}: ${JSON.stringify(body.id)}`);
      const parsed = await r.json() as Rpc;
      assert.equal(parsed.error!.code, -32600, lane);
      assert.equal(parsed.id, body.id, lane);
    }
  }
  // Control: a JSON-RPC response a client posts (a result or an error member, no method) is not a
  // request, still reaches the SDK, and is accepted on the legacy lane as before.
  for (const response of [{ jsonrpc: "2.0", id: 9, result: {} }, { jsonrpc: "2.0", id: 10, error: { code: -1, message: "x" } }]) {
    const r = await post(response);
    assert.equal(r.status, 202, JSON.stringify(response));
    await r.text();
  }
});

test("P31: a tools/call that fails the SDK's request schema names the path, not the schema library's issue list", async () => {
  // C3 finding 6: the message was the issue list, 213 to 300 characters over several lines, on
  // both lanes, where initialize answers the same class with "params.X is invalid" (P20).
  const cases: [string, Record<string, unknown>, string][] = [
    ["no name", { arguments: {} }, "params.name"],
    ["arguments as a string", { name: "get_contact", arguments: "x" }, "params.arguments"],
    ["arguments as a list", { name: "get_contact", arguments: [] }, "params.arguments"],
    ["arguments as null", { name: "get_contact", arguments: null }, "params.arguments"],
  ];
  for (const [lane, modern] of [["2026-07-28", true], ["legacy", false]] as [string, boolean][]) {
    for (const [label, params, path] of cases) {
      const name = typeof params.name === "string" ? params.name : undefined;
      const r = await post(
        { jsonrpc: "2.0", id: 91, method: "tools/call", params: modern ? { ...params, _meta: META } : params },
        modern ? MODERN_CALL_HEADERS(name) : {},
      );
      assert.equal(r.status, 200, `${lane}: ${label}`);
      const text = await r.text();
      if (!modern) assert.ok(text.startsWith("event: message\n"), `${lane}: ${label}: still one event stream frame`);
      const body = (modern ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6))) as Rpc;
      assert.equal(body.id, 91, `${lane}: ${label}`);
      assert.equal(body.error!.code, -32602, `${lane}: ${label}`);
      assert.equal(body.error!.message, `Invalid params: ${path} is invalid`, `${lane}: ${label}`);
    }
  }
  // Control: a call the schema accepts is served as before, and an unknown tool keeps its own
  // answer and data field (P16).
  const served = await call("tools/call", { name: "get_contact", arguments: {} });
  assert.deepEqual(served.structuredContent, plain(CONTACT));
  const unknown = await readJson(await post(
    { jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "missing", arguments: {}, _meta: META } },
    MODERN_CALL_HEADERS("missing"),
  ));
  assert.equal(unknown.error!.message, "Invalid params: unknown tool name");
  assert.equal(unknown.error!.data!.tool.name, "missing");
});

test("P32: the Worker's own tool errors carry serverInfo in _meta on the 2026-07-28 lane, as the SDK's do", async () => {
  // C3 finding 7: toolArgumentError results had resultType but no
  // _meta["io.modelcontextprotocol/serverInfo"], which servers SHOULD include in every result.
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const proto = await readJson(await post(raw, MODERN_CALL_HEADERS("get_contact")));
  const longKey = await call("tools/call", { name: "get_contact", arguments: { ["k".repeat(65)]: 1 } });
  const sdkOwn = await call("tools/call", { name: "get_contact", arguments: { extra: 1 } });
  assert.equal(sdkOwn.isError, true);
  assert.ok(sdkOwn._meta["io.modelcontextprotocol/serverInfo"], "the SDK's own tool error carries serverInfo");
  for (const [label, result] of [["a raw __proto__ key", proto.result!], ["an over-long key", longKey]] as [string, Result][]) {
    assert.equal(result.isError, true, label);
    assert.equal(result.resultType, "complete", label);
    assert.deepEqual(result._meta, sdkOwn._meta, label + ": the same _meta as the SDK's own tool error");
  }
  // Control: the legacy lane keeps its earlier bytes, with no _meta and no resultType.
  const legacy = await readJson(await post('{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}}}}'));
  assert.equal(legacy.result!.isError, true);
  assert.equal(legacy.result!._meta, undefined);
  assert.equal(legacy.result!.resultType, undefined);
});

test("P33b: on the 2026-07-28 lane the Worker's own checks give way to the SDK's entry ladder, with the SDK's own answer", async () => {
  // Independent check of the C3 finding 13 fix (2026-11-22): the SDK validates the _meta envelope
  // before it compares headers, and it refuses an initialize or an envelope-less request sent with
  // the modern header. Each case is sent twice: with an unknown tool name or a bad cursor, which a
  // Worker check refuses, and with a known tool or a valid cursor, which only the SDK refuses. The
  // two answers must be the same bytes apart from the id.
  const V = "io.modelcontextprotocol/protocolVersion";
  const cases: [string, (bad: boolean) => unknown, Record<string, string>, number, number][] = [
    ["an envelope without clientCapabilities and a mismatching Mcp-Name",
      (bad) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: bad ? "nope" : "get_contact", arguments: {}, _meta: { [V]: "2026-07-28" } } }),
      MODERN_CALL_HEADERS("get_services"), 400, -32602],
    ["a claimed version that is not a string and a mismatching Mcp-Method",
      (bad) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: bad ? "nope" : "get_contact", arguments: {}, _meta: { ...META, [V]: 5 } } }),
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" }, 400, -32602],
    ["an initialize sent with the modern header",
      (bad) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: bad ? {} : { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "initialize" }, 400, -32020],
    ["a modern header with no envelope claim",
      (bad) => ({ jsonrpc: "2.0", id: 1, method: "tools/list", params: bad ? { cursor: 5 } : {} }),
      MODERN_LIST_HEADERS, 400, -32602],
  ];
  for (const [label, body, headers, status, code] of cases) {
    const worker = await post(body(true), headers);
    const sdk = await post(body(false), headers);
    assert.equal(worker.status, status, label + ": the Worker's status");
    assert.equal(sdk.status, status, label + ": the SDK's status");
    const workerText = await worker.text();
    assert.equal(workerText, await sdk.text(), label + ": the same answer as the SDK's");
    assert.equal((JSON.parse(workerText) as Rpc).error!.code, code, label);
  }
});

test("P33c: control for C3 finding 13: a header that disagrees with a body the Worker passes reads 400 -32020", async () => {
  // The SDK compares Mcp-Method and Mcp-Name with the body once guardMcpPost has passed it on.
  const r = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_contact", arguments: {}, _meta: META } },
    MODERN_CALL_HEADERS("get_services"),
  );
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as Rpc).error!.code, -32020);
});

test("P33: a header that disagrees with the body reads 400 -32020 before the Worker's own checks", async () => {
  // C3 finding 13 (Erik's decision 2026-11-22): MCP 2026-07-28 says servers that process the
  // request body MUST reject a request whose headers do not match it. The Worker's unknown-tool,
  // depth, cursor and argument-key checks used to answer first, with 200 -32602 or a tool error.
  const disagree = "Bad Request: the request headers and body disagree: ";
  const deep = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_services","arguments":{},"_meta":' + JSON.stringify(META) + ',"deep":' + nestedObjects(70) + '}}';
  const proto = '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_contact","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const unknownCall = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {}, _meta: META } });
  const cases: [string, unknown, Record<string, string>, string, string][] = [
    ["an unknown tool against Mcp-Name get_services", unknownCall("no_such_tool"), MODERN_CALL_HEADERS("get_services"),
      'the body carries params.name="no_such_tool" but the Mcp-Name header names "get_services"', "get_services"],
    ["an unknown tool without Mcp-Name", unknownCall("no_such_tool"), MODERN_CALL_HEADERS(),
      'the body carries params.name="no_such_tool" but the required Mcp-Name header is absent', "(missing)"],
    ["an unknown tool and an invalid Base64 sentinel", unknownCall("no_such_tool"), MODERN_CALL_HEADERS("=?base64?not base64?="),
      "the Mcp-Name header carries an invalid Base64 sentinel value", "=?base64?not base64?="],
    ["params nested past the limit against Mcp-Method tools/list", deep, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
      "the body names method tools/call but the Mcp-Method header names tools/list", "tools/list"],
    ["a numeric cursor against Mcp-Method tools/call", { jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: 5, _meta: META } }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call" },
      "the body names method tools/list but the Mcp-Method header names tools/call", "tools/call"],
    ["a numeric cursor without Mcp-Method", { jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: 5, _meta: META } }, { "MCP-Protocol-Version": "2026-07-28" },
      "the body names method tools/list but the required Mcp-Method header is absent", "(missing)"],
    ["a raw __proto__ key against Mcp-Name get_services", proto, MODERN_CALL_HEADERS("get_services"),
      'the body carries params.name="get_contact" but the Mcp-Name header names "get_services"', "get_services"],
    ["an unknown tool and a body envelope naming 2025-11-25", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_such_tool", arguments: {}, _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } }, MODERN_CALL_HEADERS("no_such_tool"),
      "the body envelope names protocol version 2025-11-25 but the MCP-Protocol-Version header names 2026-07-28", "2026-07-28"],
  ];
  for (const [label, body, headers, reason, header] of cases) {
    const r = await post(body, headers);
    assert.equal(r.status, 400, label);
    const parsed = await r.json() as Rpc & { error: { data: { mismatch: { header: string; body: string } } } };
    assert.equal(parsed.error.code, -32020, label);
    assert.equal(parsed.error.message, disagree + reason, label);
    assert.deepEqual(parsed.error.data.mismatch, { header, body: reason }, label);
    assert.equal(typeof parsed.id === "number", true, label + ": the readable id is echoed");
  }
  // The Worker's answer has the SDK's own shape: compare a known-name mismatch, which the SDK
  // answers, with the unknown-name mismatch above, which the Worker answers.
  const sdk = await (await post(unknownCall("get_contact"), MODERN_CALL_HEADERS("get_services"))).json() as Rpc & { error: { data: unknown } };
  const own = await (await post(unknownCall("no_such_tool"), MODERN_CALL_HEADERS("get_services"))).json() as Rpc & { error: { data: unknown } };
  assert.deepEqual(Object.keys(own), Object.keys(sdk), "the same members in the same order");
  assert.deepEqual(Object.keys(own.error), Object.keys(sdk.error));
  assert.equal(own.error.message, sdk.error.message.replace('"get_contact"', '"no_such_tool"'));
  // A caller-chosen value is echoed at most 64 characters long.
  const longName = "n".repeat(200);
  const long = await post(unknownCall(longName), MODERN_CALL_HEADERS("x".repeat(200)));
  assert.equal(long.status, 400);
  const longText = await long.text();
  assert.equal(longText.includes("n".repeat(65)), false, "the body's name is cut at 64");
  assert.equal(longText.includes("x".repeat(65)), false, "the header's value is cut at 64");
  assert.ok(longText.includes("n".repeat(64)));
  // Controls: headers that agree keep the Worker's own answers, a matching Base64 sentinel is
  // decoded first, and the legacy lane, which has no such headers, is unchanged.
  const matching = await readJson(await post(unknownCall("no_such_tool"), MODERN_CALL_HEADERS("no_such_tool")));
  assert.equal(matching.error!.message, "Invalid params: unknown tool name");
  const sentinel = "=?base64?" + Buffer.from("no_such_tool").toString("base64") + "?=";
  const encoded = await readJson(await post(unknownCall("no_such_tool"), MODERN_CALL_HEADERS(sentinel)));
  assert.equal(encoded.error!.message, "Invalid params: unknown tool name");
  const deepMatching = await readJson(await post(deep, MODERN_CALL_HEADERS("get_services")));
  assert.match(deepMatching.error!.message, /nested more than 64 levels deep/);
  const legacy = await readJson(await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }, { "Mcp-Name": "get_services" }));
  assert.equal(legacy.error!.message, "Invalid params: unknown tool name", "legacy lane: the Worker's own answer");
});

// ---- Tek-908: get_page reads turva.dev through the SITE service binding -------------------------------

// A mock of the binding. It records what the tool sent, so a test can say what did and did not reach the site.
interface SiteCall { url: string; method: string; headers: Record<string, string>; redirect: string }
function mockSite(answer: (request: Request) => Response | Promise<Response>) {
  const calls: SiteCall[] = [];
  const site = {
    async fetch(request: Request) {
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), redirect: request.redirect });
      return answer(request);
    },
  };
  return { site, calls };
}
const markdownAnswer = (body: string, type = "text/markdown; charset=utf-8", status = 200) => new Response(body, { status, headers: { "Content-Type": type } });
// The caller sends headers a careless proxy would forward. None of them may reach the site.
const CALLER_HEADERS = { "Authorization": "Bearer caller-secret", "Cookie": "session=caller", "X-Forwarded-For": "203.0.113.9", "CF-Connecting-IP": "198.51.100.7", "Referer": "https://caller.example/", "User-Agent": "caller-agent" };
async function pageCall(env: Env, args: unknown): Promise<Result> {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_page", arguments: args, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_page", ...CALLER_HEADERS }, env);
  assert.equal(r.status, 200);
  const body = await readJson(r);
  assert.equal(body.error, undefined, "a refusal is a tool error and not a protocol error");
  return body.result!;
}

test("P34: get_page returns the page the site serves, sends the site only its own two headers, and does not follow a redirect", async () => {
  const text = "# llms.txt explained\n\nA page with a euro sign \u20ac and more.\n";
  const { site, calls } = mockSite(() => markdownAnswer(text));
  const res = await pageCall({ SITE: site }, { path: "/guides/llms-txt" });
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.structuredContent, { path: "/guides/llms-txt", status: 200, content_type: "text/markdown; charset=utf-8", markdown: text, bytes: new TextEncoder().encode(text).length });
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent, "the text block carries the same JSON");
  assert.equal(res.resultType, "complete");
  assert.equal(calls.length, 1, "one call, one subrequest");
  const c = calls[0]!;
  assert.equal(c.url, "https://turva.dev/guides/llms-txt");
  assert.equal(c.method, "GET");
  assert.equal(c.redirect, "manual");
  assert.deepEqual(Object.keys(c.headers).sort(), ["accept", "cf-connecting-ip"], "nothing of the caller's request is passed on");
  assert.equal(c.headers.accept, "text/markdown");
  assert.equal(c.headers["cf-connecting-ip"], "2001:db8::7475", "the constant address, not the caller's 198.51.100.7");
  // llms.txt is served as text/plain, and the tool returns it, because that is the index it tells callers to read.
  const plainSite = mockSite(() => markdownAnswer("# turva.dev\n", "text/plain; charset=utf-8"));
  const idx = await pageCall({ SITE: plainSite.site }, { path: "/llms.txt" });
  assert.notEqual(idx.isError, true);
  assert.equal(idx.structuredContent.content_type, "text/plain; charset=utf-8");
  assert.equal(idx.structuredContent.markdown, "# turva.dev\n");
  // A path that holds an at sign stays a path: the origin of the request is still turva.dev.
  const at = mockSite(() => markdownAnswer("x"));
  await pageCall({ SITE: at.site }, { path: "/@evil.example" });
  assert.equal(at.calls[0]!.url, "https://turva.dev/@evil.example");
});

test("P35: get_page refuses a path that is not a plain path on turva.dev, before any call reaches the site", async () => {
  const NUL = String.fromCharCode(0);
  const bad: string[] = [
    "//evil.example/x", "//turva.dev/x", "http://evil.example/x", "https://turva.dev/x", "evil.example/x", "@evil.example/x", "x", "",
    "/\\evil.example/x", "\\\\evil.example\\x", "/x\\y",
    "/../../etc/passwd", "/a/../b", "/a/./b", "/%2e%2e/x", "/%2E/x", "/x/..",
    "/x y", "/x\ty", "/x" + String.fromCharCode(10) + "/y", "/x" + String.fromCharCode(13) + "Host: evil.example", "/x" + NUL, "/x" + String.fromCharCode(127),
    "/\u00e4", "/x\u00a0y", "/x\u2028y",
    "/x?y=1", "/x#y", "/?", "/#",
    "/" + "a".repeat(512),
  ];
  const { site, calls } = mockSite(() => markdownAnswer("must not be read"));
  for (const path of bad) {
    const res = await pageCall({ SITE: site }, { path });
    assert.equal(res.isError, true, JSON.stringify(path) + " is refused");
    assert.equal(res.structuredContent, undefined, JSON.stringify(path));
    if (path.length <= 512) assert.match(res.content[0].text, /^Refused: /, JSON.stringify(path));
  }
  assert.equal(calls.length, 0, "no refused path reached the site");
  // The same rules, called directly: a refusal names its reason and never carries the caller's text back.
  for (const path of bad.filter((p) => p.length <= 512)) {
    const r = pageUrlFor(path);
    assert.ok("refusal" in r, JSON.stringify(path));
    if ("refusal" in r) assert.ok(!r.refusal.includes("evil"), "the reason does not echo the path");
  }
  for (const path of [123, null, undefined, {}, ["/x"]]) assert.ok("refusal" in pageUrlFor(path), "a non-string path is refused");
  // Control: ordinary paths pass, including the longest one allowed.
  for (const path of ["/", "/services", "/guides/llms-txt", "/guides/llms-txt.md", "/blog/feed.xml", "/llms.txt", "/a-b_c.d/e~f", "/%E2%82%AC", "/" + "a".repeat(511)]) {
    const r = pageUrlFor(path);
    assert.ok("url" in r, JSON.stringify(path) + " is accepted");
    if ("url" in r) assert.equal(r.url.origin, "https://turva.dev");
  }
  // An argument other than path is refused by the input schema, like every other tool's extra key.
  const extra = await pageCall({ SITE: site }, { path: "/services", host: "evil.example" });
  assert.equal(extra.isError, true);
  assert.match(extra.content[0].text, /Input validation error/);
  const missing = await pageCall({ SITE: site }, {});
  assert.equal(missing.isError, true);
  assert.equal(calls.length, 0);
});

test("P36: get_page answers a status that is not 2xx, a redirect, a wrong type, a long answer, a dead site and a missing binding as tool errors", async () => {
  const errorText = async (env: Env, path = "/guides/llms-txt") => {
    const res = await pageCall(env, { path });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent, undefined);
    return res.content[0].text as string;
  };
  for (const status of [400, 404, 410, 429, 500, 503]) {
    const { site } = mockSite(() => markdownAnswer("# Not found\n", "text/markdown", status));
    assert.match(await errorText({ SITE: site }), new RegExp("answered " + status + " for /guides/llms-txt"), String(status));
  }
  // The site's redirects are absolute https://turva.dev addresses. The tool names the path and does not follow it.
  const moved = mockSite(() => new Response(null, { status: 301, headers: { Location: "https://turva.dev/guides/llms-txt" } }));
  const movedText = await errorText({ SITE: moved.site }, "/Guides/llms-txt");
  assert.match(movedText, /answered 301 for \/Guides\/llms-txt: the page is at \/guides\/llms-txt\. Call get_page again/);
  assert.equal(moved.calls.length, 1, "the redirect is not followed");
  const away = mockSite(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } }));
  const awayText = await errorText({ SITE: away.site });
  assert.match(awayText, /does not follow/);
  assert.doesNotMatch(awayText, /evil/, "a target outside turva.dev is not repeated");
  assert.equal(away.calls.length, 1);
  const noLocation = mockSite(() => new Response(null, { status: 307 }));
  assert.match(await errorText({ SITE: noLocation.site }), /does not follow/);
  // Only text is returned.
  const html = mockSite(() => markdownAnswer("<html></html>", "text/html; charset=utf-8"));
  assert.match(await errorText({ SITE: html.site }), /neither text\/markdown nor text\/plain/);
  const json = mockSite(() => markdownAnswer("{}", "application/json"));
  assert.match(await errorText({ SITE: json.site }), /neither text\/markdown nor text\/plain/);
  const typeless = mockSite(() => new Response("x", { status: 200, headers: { "Content-Type": "" } }));
  assert.match(await errorText({ SITE: typeless.site }), /neither text\/markdown nor text\/plain/);
  // The cap: the largest allowed answer passes, one byte more is refused and not cut.
  const atCap = mockSite(() => markdownAnswer("a".repeat(262_144)));
  const ok = await pageCall({ SITE: atCap.site }, { path: "/services" });
  assert.notEqual(ok.isError, true);
  assert.equal(ok.structuredContent.bytes, 262_144);
  const overCap = mockSite(() => markdownAnswer("a".repeat(262_145)));
  assert.match(await errorText({ SITE: overCap.site }, "/services"), /longer than 262144 bytes/);
  const chunked = mockSite(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(10_000)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/plain" } }));
  assert.match(await errorText({ SITE: chunked.site }, "/services"), /longer than 262144 bytes/, "a streamed body is cut off at the cap as well");
  // A body that breaks after the headers arrived is a tool error too, and its internal message is not passed on.
  const broken = mockSite(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.error(new Error("stream broke")); } }), { status: 200, headers: { "Content-Type": "text/plain" } }));
  const brokenText = await errorText({ SITE: broken.site }, "/services");
  assert.match(brokenText, /answered|could not be read to the end/);
  assert.match(brokenText, /could not be read to the end/);
  assert.doesNotMatch(brokenText, /stream broke/);
  // A site that cannot be reached, and a deployment without the binding.
  const dead = { async fetch(): Promise<Response> { throw new Error("connection refused"); } };
  assert.match(await errorText({ SITE: dead }), /did not answer \/guides\/llms-txt within 8 seconds/);
  assert.match(await errorText({}), /site binding is missing/);
  // The refusal never echoes a caller-chosen path that was refused.
  assert.doesNotMatch(await errorText({ SITE: dead }, "/guides/llms-txt"), /connection refused/, "an internal error message is not passed on");
});

test("P37: a raw __proto__ argument to get_page is refused like any other extra key, and the tool name list still rejects an unknown name", async () => {
  const { site, calls } = mockSite(() => markdownAnswer("x"));
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_page","arguments":{"path":"/services","__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const r = await readJson(await post(raw, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_page" }, { SITE: site }));
  assert.equal(r.result!.isError, true);
  assert.match(r.result!.content[0].text, /unrecognized key\(s\) in object/);
  assert.equal(calls.length, 0);
  const unknown = await readJson(await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_pages", arguments: { path: "/services" }, _meta: META } }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_pages" }, { SITE: site }));
  assert.equal(unknown.error!.message, "Invalid params: unknown tool name");
  assert.equal(calls.length, 0);
});

// ---- Tek-915: get_page_index lists the pages of turva.dev from the site's llms.txt ------------------------------

// A cut of the real llms.txt of turva.dev: the blockquote, a section of pages, sections of plain lines, a page that is
// linked twice, the plain "Label: address" lines of the endpoint section, and a level 3 heading.
const LLMS_FIXTURE = [
  "# turva.dev",
  "",
  "> Agent-readiness audits and advisory for product teams.",
  "> Language: English. Correspondence in English or Finnish.",
  "",
  "## Services",
  "- [Services](https://turva.dev/services.md)",
  "- [Website and API agent-readiness audit](https://turva.dev/agent-readiness-audit.md)",
  "- [llms.txt validator](https://turva.dev/llms-txt-validator.md)",
  "",
  "## Pricing (EUR, VAT not included)",
  "- Audit: EUR 4,300 (fixed scope, within two weeks of the agreed written kickoff)",
  "- Implementation: EUR 1,500 / day (scoped per task)",
  "",
  "## Sample reports",
  "- [Sample audit report](https://turva.dev/samples/audit-report.md)",
  "",
  "## Contact",
  "- Email: info@turva.dev",
  "- [Contact page](https://turva.dev/contact.md)",
  "- [The services again](https://turva.dev/services.md)",
  "",
  "## Guides",
  "- [Practical guides to agent-readiness](https://turva.dev/guides.md)",
  "- [llms.txt explained](https://turva.dev/guides/llms-txt.md)",
  "### Newest guides",
  "- [Serving Markdown to AI clients](https://turva.dev/guides/markdown-for-agents.md)",
  "",
  "## Blog",
  "- [Two files called auth.md, and they disagree on the field names](https://turva.dev/blog/two-auth-md-dialects.md)",
  "- [The twin is the page](https://turva.dev/blog/the-twin-is-the-page.md)",
  "",
  "## Agent endpoints",
  "- Agent registration: https://turva.dev/auth.md",
  "- MCP Endpoint: https://mcp.turva.dev/mcp",
  "- OpenAPI: https://turva.dev/openapi.json",
  "",
].join("\n");

test("P38: parsePageIndex reads the sections and pages of llms.txt, lists a path once and ignores every line that is not a page", () => {
  const index = parsePageIndex(LLMS_FIXTURE);
  assert.deepEqual(index, {
    source: "/llms.txt",
    count: 10,
    skipped_links: 1,
    sections: [
      { title: "Services", pages: [
        { path: "/services.md", title: "Services" },
        { path: "/agent-readiness-audit.md", title: "Website and API agent-readiness audit" },
        { path: "/llms-txt-validator.md", title: "llms.txt validator" },
      ] },
      { title: "Sample reports", pages: [{ path: "/samples/audit-report.md", title: "Sample audit report" }] },
      { title: "Contact", pages: [{ path: "/contact.md", title: "Contact page" }] },
      { title: "Guides", pages: [
        { path: "/guides.md", title: "Practical guides to agent-readiness" },
        { path: "/guides/llms-txt.md", title: "llms.txt explained" },
        { path: "/guides/markdown-for-agents.md", title: "Serving Markdown to AI clients" },
      ] },
      { title: "Blog", pages: [
        { path: "/blog/two-auth-md-dialects.md", title: "Two files called auth.md, and they disagree on the field names" },
        { path: "/blog/the-twin-is-the-page.md", title: "The twin is the page" },
      ] },
    ],
  });
  assert.equal(index.count, index.sections.reduce((n, s) => n + s.pages.length, 0), "count is the sum of the listed pages");
  // Every listed path is one that get_page accepts as it stands.
  for (const s of index.sections) for (const p of s.pages) assert.ok("url" in pageUrlFor(p.path), p.path + " is accepted by get_page");
  // The pricing and endpoint sections hold no link of the page form, so they are not sections of the answer.
  assert.ok(!index.sections.some((s) => /Pricing|Agent endpoints/.test(s.title)));
});

test("P39: parsePageIndex survives an empty file, links off the site, malformed lines, line endings and a list that is too long", () => {
  assert.deepEqual(parsePageIndex(""), { source: "/llms.txt", count: 0, skipped_links: 0, sections: [] });
  assert.deepEqual(parsePageIndex("\n\n   \n"), { source: "/llms.txt", count: 0, skipped_links: 0, sections: [] });
  assert.deepEqual(parsePageIndex("# turva.dev\n> a summary only\n"), { source: "/llms.txt", count: 0, skipped_links: 0, sections: [] });
  // A link that leaves turva.dev, or that get_page would refuse, is skipped and counted, never listed.
  const off = parsePageIndex([
    "## Elsewhere",
    "- [other host](https://evil.example/x.md)",
    "- [lookalike suffix](https://turva.dev.evil.example/x.md)",
    "- [userinfo](https://turva.dev@evil.example/x.md)",
    "- [plain http](http://turva.dev/x.md)",
    "- [protocol relative](//evil.example/x.md)",
    "- [mail](mailto:info@turva.dev)",
    "- [script](javascript:void0)",
    "- [other port](https://turva.dev:8443/x.md)",
    "- [query](https://turva.dev/x.md?a=1)",
    "- [fragment](https://turva.dev/x.md#top)",
    "- [mcp host](https://mcp.turva.dev/mcp)",
    "- [empty](  )",
    "- [fine](https://turva.dev/fine.md)",
  ].join("\n"));
  assert.deepEqual(off.sections, [{ title: "Elsewhere", pages: [{ path: "/fine.md", title: "fine" }] }]);
  assert.equal(off.count, 1);
  assert.equal(off.skipped_links, 11, "the eleven refused links are counted");
  // Forms the index may use: a relative link, an upper case host, the star bullet, indentation, CRLF line endings, a link before any heading.
  const forms = parsePageIndex("- [first](/first.md)\r\n## Mixed\r\n* [star](https://TURVA.DEV/star.md)\r\n  - [indented](https://turva.dev/indented.md)\r\n+ [plus](https://turva.dev/plus.md)\r\n");
  assert.deepEqual(forms.sections.map((s) => [s.title, s.pages.map((p) => p.path)]), [["Index", ["/first.md"]], ["Mixed", ["/star.md", "/indented.md", "/plus.md"]]]);
  // Malformed or other lines are ignored without a count: no closing parenthesis, no link, a link in the middle of a sentence, a numbered item, a level 1 heading.
  const loose = parsePageIndex([
    "# [Heading link](https://turva.dev/heading.md)",
    "- [no end](https://turva.dev/no-end.md",
    "- no link at all",
    "- see [inside](https://turva.dev/inside.md) for more",
    "1. [numbered](https://turva.dev/numbered.md)",
    "- [spaced url](https://turva.dev/a b.md)",
    "[bare](https://turva.dev/bare.md)",
  ].join("\n"));
  assert.deepEqual(loose, { source: "/llms.txt", count: 0, skipped_links: 0, sections: [] });
  // A title that is empty falls back to the path, whitespace is collapsed, and a long title is cut.
  const titles = parsePageIndex("## T\n- [](https://turva.dev/empty-title.md)\n- [  two   words\t here ](https://turva.dev/ws.md)\n- [" + "x".repeat(300) + "](https://turva.dev/long.md)\n");
  assert.deepEqual(titles.sections[0]!.pages.map((p) => p.title.length > 40 ? p.title.length : p.title), ["/empty-title.md", "two words here", 200]);
  // A heading that is long is cut too, and a line of hashes with no text is not a heading.
  const heads = parsePageIndex("## " + "H".repeat(300) + "\n- [a](https://turva.dev/a.md)\n##   \n- [b](https://turva.dev/b.md)\n");
  assert.equal(heads.sections[0]!.title.length, 120);
  // A page linked twice stays in the section that linked it first, whatever section links it later.
  const dup = parsePageIndex("## One\n- [x](https://turva.dev/x.md)\n## Two\n- [x again](https://turva.dev/x.md)\n- [y](https://turva.dev/y.md)\n");
  assert.deepEqual(dup.sections.map((s) => [s.title, s.pages.map((p) => p.path)]), [["One", ["/x.md"]], ["Two", ["/y.md"]]]);
  assert.equal(dup.skipped_links, 1);
  // The cap: 500 pages are listed and the rest is counted as skipped, so a hostile index cannot make a large answer.
  const many = parsePageIndex("## Many\n" + Array.from({ length: 600 }, (_, i) => `- [p${i}](https://turva.dev/p${i}.md)`).join("\n"));
  assert.equal(many.count, 500);
  assert.equal(many.sections[0]!.pages.length, 500);
  assert.equal(many.skipped_links, 100);
});

async function pageIndexCall(env: Env, args: unknown = {}): Promise<Result> {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_page_index", arguments: args, _meta: META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_page_index", ...CALLER_HEADERS }, env);
  assert.equal(r.status, 200);
  const body = await readJson(r);
  assert.equal(body.error, undefined, "a failure is a tool error and not a protocol error");
  return body.result!;
}

test("P40: get_page_index reads /llms.txt through the site binding with the two headers of get_page and returns it parsed, as structured content and as the same JSON in text", async () => {
  const { site, calls } = mockSite(() => markdownAnswer(LLMS_FIXTURE, "text/plain; charset=utf-8"));
  const res = await pageIndexCall({ SITE: site });
  assert.notEqual(res.isError, true);
  assert.deepEqual(res.structuredContent, plain(parsePageIndex(LLMS_FIXTURE)));
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent, "the text block carries the same JSON");
  assert.equal(res.resultType, "complete");
  assert.equal(calls.length, 1, "one call, one subrequest");
  const c = calls[0]!;
  assert.equal(c.url, "https://turva.dev/llms.txt", "the only address it can read");
  assert.equal(c.method, "GET");
  assert.equal(c.redirect, "manual");
  assert.deepEqual(Object.keys(c.headers).sort(), ["accept", "cf-connecting-ip"], "nothing of the caller's request is passed on");
  assert.equal(c.headers.accept, "text/markdown");
  assert.equal(c.headers["cf-connecting-ip"], "2001:db8::7475", "the constant address, not the caller's 198.51.100.7");
  // Markdown is accepted as a content type too, and the legacy lane serves the tool as well.
  const md = mockSite(() => markdownAnswer(LLMS_FIXTURE));
  assert.equal((await pageIndexCall({ SITE: md.site })).structuredContent.count, 10);
  const legacy = await readJson(await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_page_index", arguments: {} } }, { Accept: "application/json, text/event-stream" }, { SITE: site }));
  assert.equal(legacy.result!.structuredContent.count, 10);
});

test("P41: get_page_index refuses an argument and answers a status that is not 2xx, a redirect, a wrong type, a long answer, an index without pages, a dead site and a missing binding as tool errors", async () => {
  const errorText = async (env: Env) => {
    const res = await pageIndexCall(env);
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent, undefined);
    return res.content[0].text as string;
  };
  for (const status of [404, 429, 500, 503]) {
    const { site } = mockSite(() => markdownAnswer("# Not found\n", "text/plain", status));
    assert.match(await errorText({ SITE: site }), new RegExp("answered " + status + " for /llms.txt"), String(status));
  }
  const moved = mockSite(() => new Response(null, { status: 301, headers: { Location: "https://turva.dev/llms-full.txt" } }));
  const movedText = await errorText({ SITE: moved.site });
  assert.match(movedText, /answered 301 for \/llms\.txt: the page is at \/llms-full\.txt\./);
  assert.doesNotMatch(movedText, /Call get_page again/, "a call without an argument is not told to call again with a path");
  assert.equal(moved.calls.length, 1, "the redirect is not followed");
  const away = mockSite(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } }));
  const awayText = await errorText({ SITE: away.site });
  assert.match(awayText, /does not follow/);
  assert.doesNotMatch(awayText, /evil/);
  const html = mockSite(() => markdownAnswer("<html></html>", "text/html; charset=utf-8"));
  assert.match(await errorText({ SITE: html.site }), /neither text\/markdown nor text\/plain/);
  const overCap = mockSite(() => markdownAnswer("a".repeat(262_145), "text/plain"));
  assert.match(await errorText({ SITE: overCap.site }), /longer than 262144 bytes/);
  const atCap = mockSite(() => markdownAnswer("- [x](https://turva.dev/x.md)\n" + "a".repeat(262_144 - 30), "text/plain"));
  assert.equal((await pageIndexCall({ SITE: atCap.site })).structuredContent.count, 1, "an index at the cap is read");
  const chunked = mockSite(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(10_000)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/plain" } }));
  assert.match(await errorText({ SITE: chunked.site }), /longer than 262144 bytes/, "a streamed body is cut off at the cap as well");
  const broken = mockSite(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.error(new Error("stream broke")); } }), { status: 200, headers: { "Content-Type": "text/plain" } }));
  const brokenText = await errorText({ SITE: broken.site });
  assert.match(brokenText, /could not be read to the end/);
  assert.doesNotMatch(brokenText, /stream broke/);
  // An index that holds no page of turva.dev is an error and not an empty list, and so is one whose only links leave the site.
  const empty = mockSite(() => markdownAnswer("", "text/plain"));
  assert.match(await errorText({ SITE: empty.site }), /answered 200 for \/llms\.txt, but the index lists no page of turva\.dev/);
  const foreign = mockSite(() => markdownAnswer("## Away\n- [x](https://evil.example/x.md)\n", "text/plain"));
  assert.match(await errorText({ SITE: foreign.site }), /lists no page/);
  const dead = { async fetch(): Promise<Response> { throw new Error("connection refused"); } };
  const deadText = await errorText({ SITE: dead });
  assert.match(deadText, /did not answer \/llms\.txt within 8 seconds/);
  assert.doesNotMatch(deadText, /connection refused/);
  assert.match(await errorText({}), /get_page_index is not available on this deployment: the site binding is missing/);
  // The tool reads no input: any argument is refused before the site is called, like on the five tools with compiled data.
  const { site, calls } = mockSite(() => markdownAnswer(LLMS_FIXTURE, "text/plain"));
  for (const args of [{ path: "/services" }, { path: "//evil.example/x" }, { url: "https://evil.example/" }]) {
    const res = await pageIndexCall({ SITE: site }, args);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Input validation error/);
  }
  const raw = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_page_index","arguments":{"__proto__":{"audit":true}},"_meta":' + JSON.stringify(META) + '}}';
  const proto = await readJson(await post(raw, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_page_index" }, { SITE: site }));
  assert.equal(proto.result!.isError, true);
  assert.match(proto.result!.content[0].text, /unrecognized key\(s\) in object/);
  assert.equal(calls.length, 0, "no refused call reached the site");
});
