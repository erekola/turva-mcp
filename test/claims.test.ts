import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import worker, { AGENT_READINESS, SECURITY_EVIDENCE } from "../src/index.ts";

// Published prose that no other test read until audit round 24: the SECURITY.md audit date
// and the README claims about the tool list, the header rules, the Accept rules, the
// measurement figures and the logging statement. Each check is a pure function over the
// file text, so a negative control can feed it a broken copy and prove it fails. The
// controls run on every test run, in the same test as the live check.

const read = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const README = read("README.md");
const SECURITY = read("SECURITY.md");
const WRANGLER = read("wrangler.jsonc");

type Env = Parameters<typeof worker.fetch>[1];
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
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
const CURRENT = { "MCP-Protocol-Version": "2026-07-28" };
const BOTH_ACCEPT = { Accept: "application/json, text/event-stream" };
const post = (body: unknown, headers: Record<string, string>, env: Env = {}) =>
  worker.fetch(new Request("https://mcp.turva.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env, ctx);
const toolCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_contact", arguments: {}, _meta: META } };

// ---- SECURITY.md: the audit date -------------------------------------------------------

// The text carries exactly one "Checked YYYY-MM-DD" and it has to be a real day that is not
// in the future. When the sibling turva-worker checkout is present (the workspace, not the
// standalone repository on GitHub) it also has to equal facts.json security.advisoriesCheckedAt,
// the one home of that date, which the public verify checks against turva-worker's own
// SECURITY.md. Returns the first problem found, or null.
function securityDateProblem(text: string, factsDate: string | undefined, today: Date): string | null {
  const dates = [...text.matchAll(/Checked (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
  if (dates.length !== 1) return `expected exactly one "Checked YYYY-MM-DD", found ${dates.length}`;
  const stated = dates[0];
  const parsed = new Date(stated + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== stated) return `${stated} is not a calendar day`;
  if (parsed.getTime() > today.getTime()) return `${stated} is in the future`;
  if (factsDate !== undefined && stated !== factsDate) return `${stated} differs from facts.json advisoriesCheckedAt ${factsDate}`;
  return null;
}

const FACTS_PATH = new URL("../../turva-worker/tools/facts.json", import.meta.url);
const factsDate: string | undefined = existsSync(FACTS_PATH)
  ? JSON.parse(readFileSync(FACTS_PATH, "utf8")).security?.advisoriesCheckedAt
  : undefined;

test("K1: SECURITY.md states one real audit date, and it matches facts.json where the workspace has it", () => {
  const now = new Date();
  assert.equal(securityDateProblem(SECURITY, factsDate, now), null);
  // Negative controls: a stale date, a second date, no date, a future date and an impossible day.
  const stated = SECURITY.match(/Checked (\d{4}-\d{2}-\d{2})/)![1];
  const stale = SECURITY.replace(`Checked ${stated}`, "Checked 2026-11-02");
  assert.notEqual(securityDateProblem(stale, "2026-11-05", now), null, "a date that differs from the facts fails");
  assert.notEqual(securityDateProblem(SECURITY + "\nChecked 2026-11-06\n", factsDate, now), null, "two dates fail");
  assert.notEqual(securityDateProblem(SECURITY.replace(`Checked ${stated}`, "Verified recently"), factsDate, now), null, "no date fails");
  assert.notEqual(securityDateProblem(SECURITY.replace(`Checked ${stated}`, "Checked 2999-01-01"), undefined, now), null, "a future date fails");
  assert.notEqual(securityDateProblem(SECURITY.replace(`Checked ${stated}`, "Checked 2026-02-31"), undefined, now), null, "an impossible day fails");
  if (factsDate === undefined) console.log("K1: turva-worker/tools/facts.json is not beside this checkout, so the facts.json comparison was skipped");
});

// ---- README: the tool table ----------------------------------------------------------------

const toolRows = (text: string) =>
  text.split(/\r?\n/).map((l) => l.match(/^\| `(get_[a-z_]+)` \|/)?.[1]).filter((n): n is string => n !== undefined);
const toolWords: Record<number, string> = { 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven" };
function toolTableProblem(text: string, registered: string[]): string | null {
  const rows = toolRows(text);
  if (rows.join(",") !== registered.join(",")) return `README table lists ${rows.join(",")}, the server registers ${registered.join(",")}`;
  if (!text.includes(`${toolWords[registered.length]} read-only tools`)) return `README does not say "${toolWords[registered.length]} read-only tools"`;
  return null;
}

test("K2: the README tool table lists exactly the registered tools, in order, with the count it states", async () => {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, BOTH_ACCEPT);
  const text = await r.text();
  const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  const registered = (JSON.parse(data.at(-1) ?? text).result.tools as { name: string }[]).map((t) => t.name);
  assert.equal(registered.length, 5);
  assert.equal(toolTableProblem(README, registered), null);
  const rows = README.split(/\r?\n/).filter((l) => /^\| `get_[a-z_]+` \|/.test(l));
  assert.notEqual(toolTableProblem(README.replace(rows[0], ""), registered), null, "a dropped row fails");
  assert.notEqual(toolTableProblem(README.replace("`get_principles`", "`get_principle`"), registered), null, "a renamed tool fails");
  assert.notEqual(toolTableProblem(README.replace("Five read-only tools", "Six read-only tools"), registered), null, "a wrong count fails");
});

// ---- README: header rules, Accept rules, notifications -----------------------------------

// The README sentence is the contract; the test reads the status and code out of it and holds
// the Worker to them, so changing either side alone fails.
const headerRule = (text: string) => {
  const m = text.match(/a request without one of them receives `(\d{3})` with error `(-\d+)`/);
  return m ? { status: Number(m[1]), code: Number(m[2]) } : null;
};
const acceptRule = (text: string) => {
  const m = text.match(/nothing checks `Accept`, while the legacy lane answers `(\d{3})` unless `Accept` lists both/);
  return m ? { status: Number(m[1]) } : null;
};

test("K3: a current-lane request without Mcp-Method or Mcp-Name gets the status and code the README states", async () => {
  const rule = headerRule(README);
  assert.deepEqual(rule, { status: 400, code: -32020 }, "the README states the rule");
  for (const [headers, label] of [
    [{ ...CURRENT, ...BOTH_ACCEPT, "Mcp-Name": "get_contact" }, "no Mcp-Method"],
    [{ ...CURRENT, ...BOTH_ACCEPT, "Mcp-Method": "tools/call" }, "no Mcp-Name"],
  ] as [Record<string, string>, string][]) {
    const r = await post(toolCall, headers);
    assert.equal(r.status, rule!.status, label);
    assert.equal(((await r.json()) as { error: { code: number } }).error.code, rule!.code, label);
  }
  // Negative control: the same extraction on a README with another code does not match the Worker.
  assert.notDeepEqual(headerRule(README.replace("error `-32020`", "error `-32021`")), rule);
  assert.equal(headerRule(README.replace("without one of them receives", "without one of them gets")), null, "a reworded rule is not read as satisfied");
});

test("K4: the Accept rules of both lanes are the ones the README states", async () => {
  const rule = acceptRule(README);
  assert.deepEqual(rule, { status: 406 }, "the README states the rule");
  const headers = { ...CURRENT, "Mcp-Method": "tools/call", "Mcp-Name": "get_contact" };
  const current = await post(toolCall, { ...headers, Accept: "application/json" });
  assert.equal(current.status, 200, "the current lane does not check Accept");
  await current.text();
  const currentNone = await post(toolCall, headers);
  assert.equal(currentNone.status, 200, "the current lane serves a request with no Accept at all");
  await currentNone.text();
  const legacyList = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  for (const accept of ["application/json", "text/event-stream"]) {
    const r = await post(legacyList, { Accept: accept });
    assert.equal(r.status, rule!.status, "legacy lane with Accept " + accept);
    await r.text();
  }
  const noAccept = await post(legacyList, {});
  assert.equal(noAccept.status, rule!.status, "legacy lane without Accept");
  await noAccept.text();
  const both = await post(legacyList, BOTH_ACCEPT);
  assert.equal(both.status, 200, "legacy lane with both values");
  await both.text();
  assert.equal(acceptRule(README.replace("answers `406`", "answers `415`"))!.status, 415, "negative control: the extraction follows the README");
});

test("K5: a notification skips the header check, as the README states", async () => {
  assert.ok(README.includes("A JSON-RPC notification is passed to the SDK without this header check."), "the README states it");
  const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...CURRENT, ...BOTH_ACCEPT });
  assert.equal(r.status, 202, "no Mcp-Method and no error");
  assert.equal(await r.text(), "");
  const withId = await post({ jsonrpc: "2.0", id: 5, method: "tools/list", params: { _meta: META } }, { ...CURRENT, ...BOTH_ACCEPT });
  assert.equal(withId.status, 400, "control: the same missing header on a request is refused");
  await withId.text();
});

// ---- README: the Evidence figures -------------------------------------------------------

// Figures and dates in the Evidence paragraph against the objects the tools return.
function evidenceProblem(text: string): string | null {
  const para = text.split(/\r?\n/).find((l) => l.startsWith("The bundled snapshot records"));
  if (!para) return "the Evidence paragraph is missing";
  const readiness = AGENT_READINESS.scans[0].result;
  const score = readiness.match(/^(\d+)\/100/)?.[1];
  const level = readiness.match(/Level (\d)/)?.[1];
  const siteScan = SECURITY_EVIDENCE.scans.find((s) => s.provider === "Internet.nl");
  const mailScan = SECURITY_EVIDENCE.scans.find((s) => s.provider === "Internet.nl (email)");
  const hardenize = SECURITY_EVIDENCE.scans.find((s) => s.provider === "Hardenize");
  if (!score || !level || !siteScan || !mailScan || !hardenize) return "a scan the README names is missing from the data";
  if (!para.includes(`${score}/100, Level ${level}`)) return `README does not state ${score}/100, Level ${level}`;
  if (!para.includes(`${siteScan.score}/100 on the [Internet.nl website test]`)) return "the Internet.nl website score differs";
  if (!para.includes(`${mailScan.score}/100 on its [email test]`)) return "the Internet.nl email score differs";
  const categories = (hardenize as { result: string }).result.match(/^(\d+)\/(\d+) categories passed/);
  if (!categories || categories[1] !== categories[2] || !para.includes(`all ${categories[2]} categories passed`)) return "the Hardenize result differs";
  const dates = para.match(/Hardenize reading is dated (\d{4}-\d{2}-\d{2}) and the others (\d{4}-\d{2}-\d{2})/);
  if (!dates) return "the date sentence is missing";
  if (dates[1] !== hardenize.measured_at) return `Hardenize date ${dates[1]} differs from ${hardenize.measured_at}`;
  const others = [AGENT_READINESS.measured_at, siteScan.measured_at, mailScan.measured_at];
  if (!others.every((d) => d === dates[2])) return `the others are dated ${others.join(", ")}, the README says ${dates[2]}`;
  return null;
}

test("K6: the README Evidence paragraph carries the scores and dates the tools return", () => {
  assert.equal(evidenceProblem(README), null);
  assert.notEqual(evidenceProblem(README.replace("98/100 on the", "97/100 on the")), null, "a changed Internet.nl score fails");
  assert.notEqual(evidenceProblem(README.replace("90/100 on its", "91/100 on its")), null, "a changed email score fails");
  assert.notEqual(evidenceProblem(README.replace("Level 5 Agent-Native", "Level 4 Agent-Native")), null, "a changed level fails");
  assert.notEqual(evidenceProblem(README.replace("all 24 categories passed", "all 23 categories passed")), null, "a changed Hardenize result fails");
  const hardenizeDate = SECURITY_EVIDENCE.scans[0].measured_at;
  assert.notEqual(evidenceProblem(README.replace(`dated ${hardenizeDate}`, "dated 2026-10-30")), null, "a stale Hardenize date fails");
  assert.notEqual(evidenceProblem(README.replace("the others 2026-10-29", "the others 2026-10-28")), null, "a stale date of the others fails");
});

// ---- README and wrangler.jsonc: observability ---------------------------------------

function observabilityProblem(readme: string, wrangler: string): string | null {
  if (!readme.includes("Cloudflare Workers observability is disabled")) return "the README no longer says observability is disabled";
  const stripped = wrangler.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  if (!/"observability"\s*:\s*\{\s*"enabled"\s*:\s*false\s*\}/.test(stripped)) return "wrangler.jsonc does not set observability.enabled to false";
  return null;
}

test("K7: the README statement that observability is disabled matches wrangler.jsonc", () => {
  assert.equal(observabilityProblem(README, WRANGLER), null);
  assert.notEqual(observabilityProblem(README, WRANGLER.replace(/("observability"\s*:\s*\{\s*"enabled"\s*:\s*)false/, "$1true")), null, "enabled true fails");
  assert.notEqual(observabilityProblem(README, '  // "observability": { "enabled": false }\n  "name": "x"'), null, "a commented-out setting fails");
  assert.notEqual(observabilityProblem(README.replace("observability is disabled", "observability is on"), WRANGLER), null, "a changed README fails");
});
