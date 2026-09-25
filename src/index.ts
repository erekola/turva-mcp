import { McpServer, PROTOCOL_VERSION_META_KEY, isJsonContentType } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
// The namespace import lets the bundler keep only the parts of zod the schemas below use.
// Importing the named z export instead pulled in all of zod: a dry-run build measured
// 1234.85 KiB against 688.39 KiB this way, and 679.49 KiB before the schemas existed.
import * as z from "zod";

// "The SDK" in the comments of this file is @modelcontextprotocol/server, the server package
// of the MCP TypeScript SDK. The older @modelcontextprotocol/sdk package is installed only as
// a peer dependency of agents, and this Worker does not import it.

// These data objects are exported for the tests in turva-mcp/test. The worker runtime uses
// the default export alone, so this adds a test surface and no behaviour.
export const SERVICES = {
  pricing_model: "fixed_list_prices",
  pricing_note: "The Shopify agent storefront check, audit, advisory and implementation have fixed list prices in EUR, VAT not included. Agent operations and MCP server design are scoped and quoted per engagement. Two implementation add-ons carry a fixed price and are sold only together with the diagnosis they follow, listed under bundled_implementation. Request a quote: turva.dev",
  currency: "EUR",
  vat_included: false,
  engagement: {
    communication: "async_only",
    notes: [
      "All communication is async. No calls and no calendar links.",
      "Read access is enough for the audit. Write access is scoped per task only if implementation is purchased separately.",
      "Production credentials are not requested.",
    ],
  },
  // Every deliverable here is a promise the site makes in prose, and the two are written
  // by hand in two repos. Astra measured the drift 2026-09-10: the audit deliverable did
  // not carry the re-scan within 30 days of the report that /services, /agent-readiness-
  // audit and the JSON-LD promise in seven places, the advisory deliverable dropped the
  // monthly written summary, and the Shopify retest gave 14 days without the day it
  // counts from. verify.mjs --live now reads these strings for the dated promises, so a
  // deliverable that loses one fails the gate rather than the reader.
  //
  // url is the turva.dev page that describes the service, and sample_url a published
  // sample of its deliverable where one exists. The /services anchors are the service ids.
  services: [
    {
      id: "shopify",
      name: "Shopify Agent Storefront Check",
      url: "https://turva.dev/shopify-agent-storefront-check",
      sample_url: "https://turva.dev/samples/shopify-agent-storefront-check",
      price: 999,
      unit: "fixed",
      duration: "48 hours",
      summary: "Fixed scope. One live Shopify store read across browser WebMCP, Shopify-hosted Storefront and UCP MCP, and Shopify Agentic channels. No Shopify Admin credentials are requested and no order is placed.",
      deliverable: "Four written deliverables as one package within 48 hours of the agreed written kickoff, and a fifth, the retest of up to two corrected items, within 14 days of that first package, or of the delivered corrections when the correction add-on is bought. A further retest is bought as a new check.",
    },
    {
      id: "audit",
      name: "Agent-Readiness Audit",
      url: "https://turva.dev/agent-readiness-audit",
      sample_url: "https://turva.dev/samples/audit-report",
      price: 4300,
      unit: "fixed",
      duration: "2 weeks",
      summary: "Fixed scope. An independent public scanner runs against the site or API, followed by a written report with a prioritized fix list.",
      deliverable: "A measured baseline, a clear plan for what to fix first, and a fix instruction for every finding with a link to the matching guide on turva.dev where a guide covers that surface. You also receive the recorded AI questions and answers, one round of written follow-up questions, and one re-scan within 30 days of the report, or within 30 days of the delivered corrections when the correction add-on is bought.",
    },
    {
      id: "advisory",
      name: "Advisory",
      url: "https://turva.dev/services#advisory",
      price: 3000,
      unit: "month",
      minimum_commitment: "3 months",
      summary: "Monthly retainer, async-only. Ongoing review as the site, API, or product evolves.",
      deliverable: "A monthly re-scan with the same scanner and profile, shown beside the previous result, a monthly repeat of the AI question set, written review of the agent-readiness changes your team ships within one business day, recommendations for the roadmap, questions and answers by email or a shared document, a monthly written summary that reads the month's measurements next to the previous month's, and a quarterly summary of measurable progress. The monthly summary is delivered within five business days after the month ends. Each review explains what changed and what the evidence supports. A higher score or an AI mention is not guaranteed.",
    },
    {
      id: "implementation",
      name: "Implementation",
      url: "https://turva.dev/services#implementation",
      price: 1500,
      unit: "day",
      summary: "Booked per day. Worker-level changes, well-known manifests, MCP server work, JSON-LD and Schema fixes.",
      deliverable: "The improvement is verifiable against the audit baseline in the next scan.",
    },
    {
      id: "agent-operations",
      name: "Agent Operations",
      url: "https://turva.dev/services#agent-operations",
      price: "on request",
      summary: "On request. The work beyond readiness: the data path an agent acts on, and the decision envelope of permissions and thresholds that bounds what it may decide.",
      deliverable: "A data path that holds under real conditions and a decision envelope that does exactly what it claims.",
    },
    {
      id: "mcp-server-design",
      name: "MCP Server Design",
      url: "https://turva.dev/services#mcp-server-design",
      price: "on request",
      summary: "On request. Read-only discovery tools over Streamable HTTP. For public, non-sensitive data, no auth surface and no logging by default; auth and an audit trail follow the data and the misuse model.",
      deliverable: "An endpoint that stays readable for agents without becoming an abuse vector.",
    },
  ],
  bundled_implementation: [
    {
      id: "audit-fixes",
      name: "Audit fix implementation",
      price: 499,
      unit: "fixed",
      requires: "audit",
      sold_separately: false,
      summary: "Implementation of exactly the fixes the audit report lists. Sold only together with the audit. Work outside that list is scoped at the implementation day rate.",
    },
    {
      id: "shopify-fixes",
      name: "Shopify correction implementation",
      price: 499,
      unit: "fixed",
      requires: "shopify",
      sold_separately: false,
      summary: "Implementation of exactly the corrections the Shopify agent storefront check lists. Sold only together with that check. Work outside the plan is scoped at the implementation day rate.",
    },
  ],
} as const;

export const AGENT_READINESS = {
  domain: "turva.dev",
  measured_at: "2026-09-23",
  note: "Scores are a point-in-time reading by an independent public scanner, not a permanent state. Always verify against the live links below.",
  scans: [
    {
      provider: "isitagentready.com",
      result: "100/100, Level 5 (Agent-Native)",
      note: "isitagentready.com is Cloudflare's agent-readiness scanner. The reading is the scanner's, not turva.dev's, and it can be re-run by anyone.",
      categories: {
        discoverability: "100/100",
        content: "100/100",
        bot_access_control: "100/100",
        api_auth_mcp_a2a_discovery: "100/100",
        commerce: "100/100",
      },
      url: "https://isitagentready.com/",
    },
  ],
} as const;

export const SECURITY_EVIDENCE = {
  domain: "turva.dev",
  measured_at: "2026-09-23",
  scans: [
    {
      provider: "Hardenize",
      result: "24/24 categories passed",
      url: "https://www.hardenize.com/report/turva.dev",
    },
    {
      provider: "Internet.nl",
      score: 98,
      scale: "0-100",
      note: "IPv6, DNSSEC and RPKI pass in full. The single deduction is one HTTPS sub-test, the hash function for key exchange.",
      url: "https://internet.nl/site/turva.dev/",
    },
    {
      provider: "Internet.nl (email)",
      score: 90,
      scale: "0-100",
      note: "DNSSEC, DMARC with DKIM and SPF, STARTTLS with DANE, and RPKI pass in full. The deduction is IPv6: the receiving mail servers, which the mail provider operates, publish no IPv6 address.",
      url: "https://internet.nl/mail/turva.dev/",
    },
  ],
  note: "We publish our own domain's scan results as proof that we follow the same practices we recommend to clients.",
} as const;

// measured-result says what the site says of the audit in the section What is unchanged of
// /blog/cheating-to-keep-the-old-price: the promise covers the fixes the audit report names.
// A promise of a higher reading without that bound would contradict the advisory
// deliverable above, which says in as many words that a higher score is not guaranteed.
export const PRINCIPLES = {
  model: "agent_readiness_audit",
  rules: [
    { id: "async-only", title: "All communication is async", rationale: "No calls and no calendar links. Everything stays in writing, so the work and the trail are auditable end to end." },
    { id: "least-access", title: "No production credentials, scoped write access", rationale: "Read access is enough for the audit. Write access is scoped per task only if implementation is purchased separately." },
    { id: "measured-result", title: "The result shows up in scanner numbers", rationale: "Once the fixes the audit report names are implemented, the next scan either reads higher in the categories the report named or the report explains which tradeoff was kept on purpose." },
    { id: "transparency", title: "Open and verifiable", rationale: "Backed by a registered business, Business ID 3600281-7, Finland. Our own domain's scores are publicly verifiable." },
  ],
} as const;

// The fifth tool's data. Every channel here is mirrored from
// turva-worker/tools/facts.json channels, which is the one home for them, and the
// engagement lines say the same as the /contact twin in worker.js. The channels are a
// deliberate subset of that file: email, Signal and LinkedIn are ways to start an
// engagement, while its Mastodon, Gravatar and GitHub entries are profiles, and they are
// left out here for the same reason turva-worker/tools/verify.mjs leaves them out of its
// comparison. The decision is Tek-372.
//
// A tool named get_contact ALSO exists on a different protocol: the in-page WebMCP
// script (WEBMCP_SCRIPT in worker.js) offers one to a browser. Same name, different
// shape on purpose. That one carries the Signal handle beside the link and no
// engagement fields, this one carries the first reply time and what access an audit
// needs, and the two are not merged because the WebMCP script's bytes are pinned by a
// CSP script-src hash, so a field added there is a deploy-time hash change. The values
// they share come from the same facts.json entries, so they cannot drift apart in
// substance; if either one gains a CHANNEL, change facts.json first and mirror both.
//
// The operator object says who runs turva.dev in the words of the Business details section
// of the /company twin in worker.js, and its business_id and vat_id are facts.json businessId
// and vatId, which the public verify compares live. It was added in 1.6.0 because Glama's
// tool-definition review found no company background or team information in the tool set,
// although the /company page states both.
export const CONTACT = {
  email: "info@turva.dev",
  signal: "https://signal.me/#eu/2qzayURnxbJ8wl7dmQOd5c3sAF7cW8xvDVUrNiG6Cl7rEsXfkSlIsYOS9FSjJixK",
  linkedin: "https://www.linkedin.com/in/erikrekola/",
  business_id: "3600281-7",
  location: "Tampere, Finland",
  engagement: "async_only",
  correspondence_languages: ["en", "fi"],
  first_reply: "Within one business day, in writing, by email or Signal. LinkedIn messages have no set reply time.",
  channel_note: "Email for longer messages, Signal for short questions. No calls and no calendar links.",
  how_to_start: [
    "Email the domain you want read. That is enough to start.",
    "Read access is enough for the audit. Production credentials are not requested.",
    "Write access to repositories is scoped per task, and only if implementation is purchased separately.",
  ],
  operator: {
    name: "turva.dev",
    run_by: "Erik Rekola",
    legal_form: "Sole proprietorship registered in Finland",
    business_id: "3600281-7",
    vat_id: "FI36002817",
    location: "Tampere, Pirkanmaa, Finland",
    team: "One person. Clients work directly with Erik Rekola, from agreeing the scope to reading the findings.",
    background: "Erik Rekola is an independent consultant in Tampere. Before turva.dev, Erik Rekola worked hands-on with industrial and laboratory equipment from 2015 to 2021: paper machinery at UPM, medical washer-disinfectors at Franke, a clinical LC-MS/MS analyser at Thermo Fisher Scientific and semiconductor production equipment at ASM International.",
    company_page: "https://turva.dev/company",
  },
} as const;

// One output schema per tool, written against the objects above. Every object is strict, so
// the SDK's check of structuredContent against the schema fails on a field the schema does
// not name, and test/protocol.test.mjs calls every tool: a field added above without its
// schema fails the tests before it can fail a client.
//
// No tool reads its input. noArguments makes the published inputSchema say so with
// additionalProperties false, and a call that passes an argument anyway gets a tool error, a
// result with isError set to true, which is how the SDK reports every input validation failure.
const noArguments = z.strictObject({});

const servicesOutput = z.strictObject({
  pricing_model: z.string(),
  pricing_note: z.string(),
  currency: z.string(),
  vat_included: z.boolean(),
  engagement: z.strictObject({ communication: z.string(), notes: z.array(z.string()) }),
  services: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    url: z.string().describe("The turva.dev page that describes the service."),
    sample_url: z.string().optional().describe("A published sample of the deliverable, where one exists."),
    price: z.union([z.number(), z.literal("on request")]).describe("EUR, VAT not included, or on request."),
    unit: z.string().optional(),
    duration: z.string().optional(),
    minimum_commitment: z.string().optional(),
    summary: z.string(),
    deliverable: z.string(),
  })),
  bundled_implementation: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    unit: z.string(),
    requires: z.string().describe("The id of the service this add-on is sold with."),
    sold_separately: z.boolean(),
    summary: z.string(),
  })),
});

const readinessOutput = z.strictObject({
  domain: z.string(),
  measured_at: z.string().describe("Date of the reading, YYYY-MM-DD."),
  note: z.string(),
  scans: z.array(z.strictObject({
    provider: z.string(),
    result: z.string(),
    note: z.string(),
    categories: z.record(z.string(), z.string()),
    url: z.string(),
  })),
});

const securityOutput = z.strictObject({
  domain: z.string(),
  measured_at: z.string().describe("Date of the scans, YYYY-MM-DD."),
  scans: z.array(z.strictObject({
    provider: z.string(),
    result: z.string().optional(),
    score: z.number().optional(),
    scale: z.string().optional(),
    note: z.string().optional(),
    url: z.string(),
  })),
  note: z.string(),
});

const principlesOutput = z.strictObject({
  model: z.string(),
  rules: z.array(z.strictObject({ id: z.string(), title: z.string(), rationale: z.string() })),
});

const contactOutput = z.strictObject({
  email: z.string(),
  signal: z.string(),
  linkedin: z.string(),
  business_id: z.string(),
  location: z.string(),
  engagement: z.string(),
  correspondence_languages: z.array(z.string()),
  first_reply: z.string(),
  channel_note: z.string(),
  how_to_start: z.array(z.string()),
  operator: z.strictObject({
    name: z.string(),
    run_by: z.string(),
    legal_form: z.string(),
    business_id: z.string(),
    vat_id: z.string(),
    location: z.string(),
    team: z.string(),
    background: z.string(),
    company_page: z.string().describe("The turva.dev page that states the business details."),
  }),
});

// Every tool returns its data twice: as structuredContent, which its outputSchema describes,
// and as the same JSON in a text block for clients that read text only, as the revision
// recommends. Both come from the one object, so they cannot drift apart.
function dataResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// Read-only annotations, identical on all five tools. Declared once so the five
// registrations cannot drift apart, which is the same failure class the signed
// server card has already produced twice.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// A fresh server per request. The 2026-07-28 revision is stateless, and stateless here
// means that nothing survives the request, not that the endpoint refuses to shake hands.
// Measured live against https://mcp.turva.dev/mcp on 2026-09-02: an initialize call is
// answered normally, with serverInfo turva-mcp 1.3.9 and protocolVersion 2025-06-18
// negotiated by the SDK. What is absent is everything after it. The response carries no
// Mcp-Session-Id header, no session is kept alive, nothing here is shared between
// requests and no Durable Object is needed, so initialize is answered and then
// forgotten.
//
// Reworded twice on 2026-09-01. The original wording asserted that the handshake itself
// was absent, which would tell a reader that a standard MCP client cannot connect; it
// can. The first rewrite fixed the claim but QUOTED the wrong phrase verbatim while
// correcting it, which left the defect string in the file: three consecutive audit runs
// grepped it, found a real hit, and reported an already-fixed line as unfixed. The phrase
// is therefore described here and never repeated. General rule for this repo: a comment
// that corrects a claim states the correct claim, and does not carry the wrong one along
// as a quotation, because the file is read by grep before it is read by a person.
//
// server/discover is installed by the SDK itself and is deliberately not implemented by hand.
// What it returns is set here: the identity, the capabilities and the instructions.
//
// The identity carries the title and description of the serverInfo in the signed server
// card on turva.dev, and the card's websiteUrl, so a client that reads only the protocol
// sees what a reader of the card sees. Its version moves with package.json and the card.
const SERVER_INFO = {
  name: "turva-mcp",
  title: "turva.dev",
  version: "1.6.1",
  description: "Public read-only MCP server for turva.dev. Exposes the service catalog (Shopify agent storefront check, audit, advisory, implementation, agent operations, MCP server design) with prices, own-domain agent-readiness and web-security scan evidence, and engagement principles (async-only, no calls, no calendar links). No authentication, no write operations.",
  websiteUrl: "https://turva.dev/",
};

// Each tool description repeats the routing to its neighbours, and this says it once for a
// client that reads server/discover, or initialize on the 2025-era lane, before it lists the
// tools.
const INSTRUCTIONS = "Five read-only tools answer questions about turva.dev itself. Use get_services for the services, their prices and how an engagement runs. Use get_contact for who runs turva.dev, how to reach it and what access an audit needs, and get_principles for the rules an engagement follows. get_agent_readiness returns turva.dev's own score from the independent scanner isitagentready.com. get_security_evidence returns its own web-security scan results, which are a separate measurement. No tool takes arguments. The data is compiled into the server, carries a date where it is a measurement, and changes only on deploy. This server does not scan or audit other sites.";

function createServer(): McpServer {
  const server = new McpServer(
    SERVER_INFO,
    {
      // listChanged is false because this server never sends notifications/tools/list_changed:
      // the five tools are compiled in and change only on deploy, and no request outlives its
      // response. @modelcontextprotocol/server 2.0.0 sets the flag to true at the first
      // registerTool unless the code that creates the server passes a value. Without this line
      // the endpoint advertises a notification it never sends, and subscriptions/listen
      // acknowledges a tools filter that can never fire, as measured on 2026-09-23.
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      // The revision requires ttlMs and cacheScope on every cacheable result. The SDK
      // would default them to 0 and private. These five tools are static data compiled
      // into the Worker, so the answer is byte-identical for every caller and changes
      // only on deploy: public is a true statement about this server, not an
      // optimization, and one hour is well inside how often it is redeployed.
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "get_services",
    {
      title: "Service catalog and pricing",
      description: "Returns turva.dev's service catalog: the Shopify agent storefront check, agent-readiness audit, advisory, implementation, agent operations, and MCP server design, plus the engagement model and pricing (fixed list prices for the Shopify agent storefront check, audit, advisory and implementation; agent operations and MCP server design on request), and two implementation add-ons that carry a fixed price and are sold only together with the diagnosis they follow. Use this when a user asks what turva.dev offers, what it costs, or how an engagement works. For how to reach turva.dev use get_contact instead, and for the rules an engagement follows use get_principles. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: servicesOutput,
    },
    async () => dataResult(SERVICES),
  );

  server.registerTool(
    "get_agent_readiness",
    {
      title: "Agent-readiness score",
      description: "Returns turva.dev's own agent-readiness score from an independent public scanner (isitagentready.com), including category sub-scores, with the measurement date and verification links. Use this when a user asks how turva.dev scores, whether its claims are verifiable, or what proof backs the audit service. For web-security scan results, which are a separate measurement, use get_security_evidence instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: readinessOutput,
    },
    async () => dataResult(AGENT_READINESS),
  );

  server.registerTool(
    "get_security_evidence",
    {
      title: "Web-security scan evidence",
      description: "Returns the latest public web-security scan results for turva.dev's own domain (Hardenize, Internet.nl site and mail), with the scan date. Use this when a user asks about turva.dev's own security posture or wants evidence beyond agent-readiness scores. For the agent-readiness score itself, which is a separate measurement, use get_agent_readiness instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: securityOutput,
    },
    async () => dataResult(SECURITY_EVIDENCE),
  );

  server.registerTool(
    "get_principles",
    {
      title: "Engagement principles",
      description: "Returns turva.dev's engagement principles: async-only, least access, the result shows up in scanner numbers, and open and verifiable. Use this when a user asks how turva.dev works with clients or what rules an engagement follows. For what is sold and what it costs use get_services instead, and for how to start use get_contact. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: principlesOutput,
    },
    async () => dataResult(PRINCIPLES),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Contact and operator details",
      description: "Returns who runs turva.dev and the official ways to reach it: the operator and business details, the email address, the Signal link, the LinkedIn profile, the correspondence languages, the first-reply time and the access an audit needs. Use this when a user asks who is behind turva.dev, how to contact it, how to start an audit or what access has to be granted. For what is sold and what it costs use get_services instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: contactOutput,
    },
    async () => dataResult(CONTACT),
  );

  return server;
}

// CORS for the MCP endpoint itself. Every value here is a claim about what this
// endpoint actually does, so none of it is copied from a default:
// - methods lists POST and OPTIONS only, because GET and DELETE were session
//   operations and now answer 405.
// - headers carries exactly the three the revision defines for a POST plus
//   Content-Type and Accept. mcp-session-id and last-event-id are gone from the
//   protocol, so advertising them would be a surface that does not exist.
// - origin is turva.dev rather than a wildcard, because allowedOriginHostnames
//   below actually enforces that list. A wildcard here would advertise access
//   that the Origin check then refuses.
const MCP_CORS = {
  origin: "https://turva.dev",
  methods: "POST, OPTIONS",
  headers: "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  exposeHeaders: "",
  maxAge: 86400,
};

// Browser Origins allowed to reach the endpoint. The list is explicit because relying
// on the handler's default would make this a derived surface: agents 0.20.1 builds that
// default at request time from the localhost class, the workers.dev hostname when that
// endpoint is enabled, and the hostname of corsOptions.origin, which here is turva.dev.
// Editing MCP_CORS.origin would then silently change who may reach the endpoint, and a
// wrong Origin list fails only for browsers: non-browser clients send no Origin at all,
// so it is invisible to curl and to every gate we run. "*" is not used either: it
// disables the Origin check the revision expects an HTTP MCP server to perform.
//
// This check compares hostnames only. The SDK parses the Origin as a URL and looks its
// hostname up in this list, so the scheme and the port take no part and the parse folds
// letter case: http://turva.dev and https://turva.dev:8443 pass as well as https://turva.dev.
// That is accepted on purpose. 8443 is one of the HTTPS ports Cloudflare serves the same
// zone on, every value this endpoint returns is public, and the list exists to keep other
// sites' pages out.
//
// Corrected 2026-08-16 (round 12, batch E16, finding B3-7). This comment described the
// handler's default as covering nothing but the localhost class and the workers.dev
// hostname, and concluded that it would therefore reject every browser request.
// Measured against the pinned dependency, the default also adds the corsOptions.origin
// hostname, so it would have included turva.dev. The configuration is right; the reason
// written beside it was not.
const MCP_ALLOWED_ORIGIN_HOSTNAMES = ["turva.dev"];

// The discovery documents below are plain JSON read by directories and crawlers,
// not MCP traffic, so they keep the open cross-origin policy they have always had.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// The rate limit, written once: RateLimit-Policy and the 429 answer below are derived from
// it. wrangler.jsonc configures the binding with the same two numbers, and the binding
// exposes limit() alone, so test/protocol.test.mjs compares the two files.
const RATE_LIMIT = { requests: 100, windowSeconds: 60 } as const;

// The same protections turva.dev applies to its agent-API responses. This endpoint is
// public, unauthenticated and read cross-origin by agents, so Cross-Origin-Resource-Policy
// is cross-origin while the rest is closed. Nothing here serves HTML or loads a subresource,
// so the policy is default-src none. RateLimit-Policy is sent because the limiter in fetch()
// below applies it. An advertised limit that no code applies is exactly the
// declared-but-unresolved surface this service audits for. It states the configured quota,
// not an exact ceiling. Cloudflare's rate-limiting binding counts per location and
// approximately: on 2026-09-23 a burst of 300 requests from one address in 5 seconds met its
// first 429 at about request 234, and 260 requests spread over 48 seconds all passed.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "RateLimit-Policy": `"default";q=${RATE_LIMIT.requests};w=${RATE_LIMIT.windowSeconds}`,
};

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  // The handler merges its own CORS defaults, so an empty exposeHeaders value still ships
  // as a present but valueless Access-Control-Expose-Headers line (measured 2026-07-29).
  // There is nothing on a response worth exposing once mcp-session-id is gone, and a header
  // that declares nothing is still a declared surface, so it is removed rather than emptied.
  if (headers.get("access-control-expose-headers") === "") headers.delete("access-control-expose-headers");
  // RFC 9110 requires an Allow header on a 405, and the handler's own 405 for GET and DELETE
  // has none. It names the methods the preflight advertises, from the same list.
  if (res.status === 405) headers.set("Allow", MCP_CORS.methods);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// The narrow /mcp policy applied to a response the MCP handler never sees, so a rate-limited
// answer describes the same endpoint the same way an accepted one does.
function withMcpCorsHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", MCP_CORS.origin);
  headers.set("Access-Control-Allow-Methods", MCP_CORS.methods);
  headers.set("Access-Control-Allow-Headers", MCP_CORS.headers);
  headers.set("Access-Control-Max-Age", String(MCP_CORS.maxAge));
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// The discovery documents change only on deploy, so a client may keep them for the same hour
// the cacheHints above give tools/list and server/discover.
const DISCOVERY_CACHE_CONTROL = "public, max-age=3600";

// RFC 9110, section 9.3.2, defines HEAD as a GET without the body. Cloudflare's edge already
// strips a HEAD body in production, and answering without one here keeps the Worker correct
// on its own.
function discoveryDocument(head: boolean, doc: Record<string, unknown>): Response {
  return withHeaders(new Response(head ? null : JSON.stringify(doc), {
    headers: { "Content-Type": "application/json", "Cache-Control": DISCOVERY_CACHE_CONTROL },
  }));
}

// Limits the SDK leaves to its host, applied to a POST on /mcp before the handler sees it.
// Measured on 2026-09-23 in audit round 20: the 2025-era lane answered a JSON-RPC batch of 100
// tools/call requests sent in one POST, which the limiter counts as one request, and no size
// limit applied, so a 50 MB body was read into memory whole. The 2026-07-28 lane already
// refuses a batch, and this refuses it on both lanes. A request that belongs to the
// 2026-07-28 lane, by its body envelope or by its Mcp-Method header, must also carry
// MCP-Protocol-Version: the revision requires the header, and the SDK reads the version from
// the body alone, so without this check it answers a request that lacks the header.
// Notifications are left to the SDK, which checks its own required headers on requests only.
const MAX_BODY_BYTES = 65_536;

function mcpError(status: number, code: number, message: string, id: string | number | null = null, data?: Record<string, unknown>): Response {
  return withMcpCorsHeaders(Response.json(
    { jsonrpc: "2.0", error: { code, message, ...(data === undefined ? {} : { data }) }, id },
    { status },
  ));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reads the body chunk by chunk and stops at the limit, so an oversized body is never held
// whole, including one sent without a Content-Length header.
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function guardMcpPost(request: Request): Promise<Request | Response> {
  const tooLarge = () => mcpError(413, -32000, `Content Too Large: the request body may be at most ${MAX_BODY_BYTES} bytes`);
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) return tooLarge();
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (bytes === null) return tooLarge();
  // The SDK answers a body not declared as JSON with 415 before it reads it as JSON-RPC, so
  // the checks below leave such a body to it and keep that order.
  if (isJsonContentType(request.headers.get("Content-Type"))) {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = undefined; // not JSON: the SDK answers it with its own parse error
    }
    if (Array.isArray(body)) {
      return mcpError(400, -32600, "Bad Request: JSON-RPC batches are not supported by this endpoint");
    }
    if (isPlainObject(body) && typeof body.method === "string"
      && (typeof body.id === "string" || typeof body.id === "number")
      && !request.headers.has("MCP-Protocol-Version")) {
      const meta = isPlainObject(body.params) && isPlainObject(body.params._meta) ? body.params._meta : undefined;
      const claim = meta !== undefined && PROTOCOL_VERSION_META_KEY in meta;
      if (claim || request.headers.has("Mcp-Method")) {
        const reason = claim
          ? "the body carries the per-request protocol version envelope but the required MCP-Protocol-Version header is absent"
          : "the Mcp-Method header is present but the required MCP-Protocol-Version header is absent";
        // The same shape and code the SDK gives a missing Mcp-Method header.
        return mcpError(400, -32020, `Bad Request: the request headers and body disagree: ${reason}`, body.id, { mismatch: { header: "(missing)", body: reason } });
      }
    }
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal });
}

// Typed structurally rather than against an ambient binding type, so the shape this code
// depends on is visible here and a workers-types bump cannot change it silently.
interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  RATE_LIMITER?: RateLimiterBinding;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Applied before anything else, so a burst from one address meets the limiter before it
    // reaches the MCP handler. The binding counts per Cloudflare location and approximately,
    // as the note on RATE_LIMIT above says, so it slows a burst down rather than cutting it
    // at an exact count. Fail open: a missing or erroring binding serves the request normally
    // instead of taking the endpoint down.
    if (env.RATE_LIMITER) {
      try {
        // Cloudflare's edge sets CF-Connecting-IP on every request it passes to the Worker.
        // The fallback key covers a request without the header, such as a local test, and
        // all such requests share one bucket.
        const key = request.headers.get("CF-Connecting-IP") || "no-ip";
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) {
          const limited = new Response(
            `429 Too Many Requests. This endpoint allows about ${RATE_LIMIT.requests} requests per ${RATE_LIMIT.windowSeconds} seconds per client IP. Each Cloudflare location keeps its own approximate count, so a burst can pass more requests before this answer. Retry after ${RATE_LIMIT.windowSeconds} seconds.\n`,
            { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(RATE_LIMIT.windowSeconds) } },
          );
          // The limiter runs before path routing, so without this the 429 answered with the
          // discovery routes' wildcard policy on /mcp too, advertising both a wildcard origin
          // and a GET method that /mcp itself refuses with 405.
          const limitedPath = new URL(request.url).pathname;
          return limitedPath === "/mcp" || limitedPath === "/mcp/"
            ? withMcpCorsHeaders(limited)
            : withHeaders(limited);
        }
      } catch (err) {
        console.error("Rate limiter error (failing open):", err instanceof Error ? err.stack : String(err));
      }
    }
    const url = new URL(request.url);
    const preflight = request.method.toUpperCase() === "OPTIONS";
    // A trailing slash is a common way to mistype the endpoint. 308 keeps the method and the
    // body, so a POST that follows it reaches /mcp unchanged, and the query string is kept.
    // Location is a path and not a URL built from the request, so it can only point at this
    // host. A preflight is the exception: a browser does not follow a redirect on one, so
    // OPTIONS /mcp/ is answered below as the preflight for /mcp.
    if (url.pathname === "/mcp/" && !preflight) {
      return withMcpCorsHeaders(new Response(null, { status: 308, headers: { Location: "/mcp" + url.search } }));
    }
    // /mcp is handled first and including its preflight, because the handler owns both
    // the CORS answer and the Origin check for that path. Answering OPTIONS here instead
    // would advertise a permission the handler then refuses on the POST that follows.
    // A POST passes guardMcpPost first, for the limits the SDK does not set.
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      let forwarded = url.pathname === "/mcp" ? request : new Request(new URL("/mcp" + url.search, url), request);
      if (request.method.toUpperCase() === "POST") {
        const guarded = await guardMcpPost(request);
        if (guarded instanceof Response) return guarded;
        forwarded = guarded;
      }
      const res = await createMcpHandler(createServer, {
        route: "/mcp",
        corsOptions: MCP_CORS,
        allowedOriginHostnames: MCP_ALLOWED_ORIGIN_HOSTNAMES,
      })(forwarded, env, ctx);
      return withSecurityHeaders(res);
    }
    if (request.method === "OPTIONS") {
      return withHeaders(new Response(null, { status: 204 }));
    }
    // The discovery documents are read-only. CORS_HEADERS above promises GET and OPTIONS,
    // and until round 16 (C7-1, measured 2026-09-03) POST and DELETE on / answered 200 with
    // the same body, so the header was a claim the routing did not keep. HEAD is a GET
    // without the body and stays allowed.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withHeaders(new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD, OPTIONS" } }));
    }
    const head = request.method === "HEAD";
    if (url.pathname === "/" || url.pathname === "/.well-known/mcp") {
      return discoveryDocument(head, { name: "turva-mcp", transport: "streamable-http", endpoint: "https://mcp.turva.dev/mcp" });
    }
    if (url.pathname === "/.well-known/glama.json") {
      return discoveryDocument(head, { "$schema": "https://glama.ai/mcp/schemas/connector.json", maintainers: [{ email: "info@turva.dev" }] });
    }
    return withHeaders(new Response(head ? null : "Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  },
} satisfies ExportedHandler<Env>;
