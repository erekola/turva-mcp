import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

const SERVICES = {
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
  services: [
    {
      id: "shopify",
      name: "Shopify Agent Storefront Check",
      price: 999,
      unit: "fixed",
      duration: "48 hours",
      summary: "Fixed scope. One live Shopify store read across browser WebMCP, Shopify-hosted Storefront and UCP MCP, and Shopify Agentic channels. No Shopify Admin credentials are requested and no order is placed.",
      deliverable: "Four written deliverables as one package within 48 hours of the agreed written kickoff, and a fifth, the retest of up to two corrected items, within 14 days.",
    },
    {
      id: "audit",
      name: "Agent-Readiness Audit",
      price: 4300,
      unit: "fixed",
      duration: "2 weeks",
      summary: "Fixed scope. An independent public scanner runs against the site or API, followed by a written report with a prioritized fix list.",
      deliverable: "A measured baseline, a clear plan for what to fix first, and a fix instruction for every finding with a link to the matching guide on turva.dev where a guide covers that surface.",
    },
    {
      id: "advisory",
      name: "Advisory",
      price: 3000,
      unit: "month",
      minimum_commitment: "3 months",
      summary: "Monthly retainer, async-only. Ongoing review as the site, API, or product evolves.",
      deliverable: "A monthly re-scan with the same scanner and profile, shown beside the previous result, a monthly repeat of the AI question set, written review of the agent-readiness changes your team ships, and a quarterly summary. Each review explains what changed and what the evidence supports. A higher score or an AI mention is not guaranteed.",
    },
    {
      id: "implementation",
      name: "Implementation",
      price: 1500,
      unit: "day",
      summary: "Booked per day. Worker-level changes, well-known manifests, MCP server work, JSON-LD and Schema fixes.",
      deliverable: "The improvement is verifiable against the audit baseline in the next scan.",
    },
    {
      id: "agent-operations",
      name: "Agent Operations",
      price: "on request",
      summary: "On request. The work beyond readiness: the data path an agent acts on, and the decision envelope of permissions and thresholds that bounds what it may decide.",
      deliverable: "A data path that holds under real conditions and a decision envelope that does exactly what it claims.",
    },
    {
      id: "mcp-server-design",
      name: "MCP Server Design",
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

const AGENT_READINESS = {
  domain: "turva.dev",
  measured_at: "2026-09-06",
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

const SECURITY_EVIDENCE = {
  domain: "turva.dev",
  measured_at: "2026-09-06",
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
      score: 95,
      scale: "0-100",
      note: "IPv6, DNSSEC, DMARC with DKIM and SPF, and RPKI pass in full. The deduction is in the cipher configuration of the receiving mail servers, which the mail provider operates.",
      url: "https://internet.nl/mail/turva.dev/",
    },
  ],
  note: "We publish our own domain's scan results as proof that we follow the same practices we recommend to clients.",
} as const;

const PRINCIPLES = {
  model: "agent_readiness_audit",
  rules: [
    { id: "async-only", title: "All communication is async", rationale: "No calls and no calendar links. Everything stays in writing, so the work and the trail are auditable end to end." },
    { id: "least-access", title: "No production credentials, scoped write access", rationale: "Read access is enough for the audit. Write access is scoped per task only if implementation is purchased separately." },
    { id: "measured-result", title: "The result shows up in scanner numbers", rationale: "Once the fixes are implemented, the next scan reads higher than the previous one, in the categories the report named, by the dates it named, or the report explains why a tradeoff was kept on purpose." },
    { id: "transparency", title: "Open and verifiable", rationale: "Backed by a registered business, Business ID 3600281-7, Finland. Our own domain's scores are publicly verifiable." },
  ],
} as const;

// The fifth tool's data. Every channel here is mirrored from
// turva-worker/tools/facts.json channels, which is the one home for them, and the
// engagement lines say the same as the /contact twin in worker.js.
//
// A tool named get_contact ALSO exists on a different protocol: the in-page WebMCP
// script (WEBMCP_SCRIPT in worker.js) offers one to a browser. Same name, different
// shape on purpose. That one carries the Signal handle beside the link and no
// engagement fields, this one carries the first reply time and what access an audit
// needs, and the two are not merged because the WebMCP script's bytes are pinned by a
// CSP script-src hash, so a field added there is a deploy-time hash change. The values
// they share come from the same facts.json entries, so they cannot drift apart in
// substance; if either one gains a CHANNEL, change facts.json first and mirror both.
const CONTACT = {
  email: "info@turva.dev",
  signal: "https://signal.me/#eu/2qzayURnxbJ8wl7dmQOd5c3sAF7cW8xvDVUrNiG6Cl7rEsXfkSlIsYOS9FSjJixK",
  linkedin: "https://www.linkedin.com/in/erikrekola/",
  business_id: "3600281-7",
  location: "Tampere, Finland",
  engagement: "async_only",
  correspondence_languages: ["en", "fi"],
  first_reply: "Within one business day, in writing.",
  channel_note: "Email for longer messages, Signal for short questions. No calls and no calendar links.",
  how_to_start: [
    "Email the domain you want read. That is enough to start.",
    "Read access is enough for the audit. Production credentials are not requested.",
    "Write access to repositories is scoped per task, and only if implementation is purchased separately.",
  ],
} as const;

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
function createServer(): McpServer {
  const server = new McpServer(
    { name: "turva-mcp", version: "1.4.1" },
    {
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
    },
    async () => textResult(SERVICES),
  );

  server.registerTool(
    "get_agent_readiness",
    {
      title: "Agent-readiness score",
      description: "Returns turva.dev's own agent-readiness score from an independent public scanner (isitagentready.com), including category sub-scores, with the measurement date and verification links. Use this when a user asks how turva.dev scores, whether its claims are verifiable, or what proof backs the audit service. For web-security scan results, which are a separate measurement, use get_security_evidence instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
    },
    async () => textResult(AGENT_READINESS),
  );

  server.registerTool(
    "get_security_evidence",
    {
      title: "Web-security scan evidence",
      description: "Returns the latest public web-security scan results for turva.dev's own domain (Hardenize, Internet.nl site and mail), with the scan date. Use this when a user asks about turva.dev's own security posture or wants evidence beyond agent-readiness scores. For the agent-readiness score itself, which is a separate measurement, use get_agent_readiness instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
    },
    async () => textResult(SECURITY_EVIDENCE),
  );

  server.registerTool(
    "get_principles",
    {
      title: "Engagement principles",
      description: "Returns turva.dev's engagement principles: async-only, least access, the result shows up in scanner numbers, and open and verifiable. Use this when a user asks how turva.dev works with clients or what rules an engagement follows. For what is sold and what it costs use get_services instead, and for how to start use get_contact. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
    },
    async () => textResult(PRINCIPLES),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Contact and how to start",
      description: "Returns the official ways to reach turva.dev and what starting an engagement takes: the email address, the Signal link, the LinkedIn profile, the business ID and location, the correspondence languages, the first-reply time, and the access an audit needs. Use this when a user asks how to contact turva.dev, how to start an audit, or what access has to be granted. For what is sold and what it costs use get_services instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
    },
    async () => textResult(CONTACT),
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

// The same protections turva.dev applies to its agent-API responses. This endpoint is
// public, unauthenticated and read cross-origin by agents, so Cross-Origin-Resource-Policy
// is cross-origin while the rest is closed. Nothing here serves HTML or loads a subresource,
// so the policy is default-src none. RateLimit-Policy is sent only because the limiter in
// fetch() below actually enforces it; an advertised limit that no code enforces is exactly
// the declared-but-unresolved surface this service audits for.
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
  "RateLimit-Policy": "\"default\";q=100;w=60",
};

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  // The handler merges its own CORS defaults, so an empty exposeHeaders value still ships
  // as a present but valueless Access-Control-Expose-Headers line (measured 2026-07-29).
  // There is nothing on a response worth exposing once mcp-session-id is gone, and a header
  // that declares nothing is still a declared surface, so it is removed rather than emptied.
  if (headers.get("access-control-expose-headers") === "") headers.delete("access-control-expose-headers");
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
    // Enforced before anything else, so a burst cannot reach the MCP handler faster than
    // the declared policy allows. Fail open: a missing or erroring binding serves the
    // request normally instead of taking the endpoint down.
    if (env.RATE_LIMITER) {
      try {
        const key = request.headers.get("CF-Connecting-IP") || "no-ip";
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) {
          const limited = new Response(
            "429 Too Many Requests. This endpoint enforces its declared rate limit of 100 requests per 60 seconds per client IP. Retry after 60 seconds.\n",
            { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" } },
          );
          // The limiter runs before path routing, so without this the 429 answered with the
          // discovery routes' wildcard policy on /mcp too, advertising both a wildcard origin
          // and a GET method that /mcp itself refuses with 405.
          return new URL(request.url).pathname === "/mcp"
            ? withMcpCorsHeaders(limited)
            : withHeaders(limited);
        }
      } catch (err) {
        console.error("Rate limiter error (failing open):", err instanceof Error ? err.stack : String(err));
      }
    }
    const url = new URL(request.url);
    // /mcp is handled first and including its preflight, because the handler owns both
    // the CORS answer and the Origin check for that path. Answering OPTIONS here instead
    // would advertise a permission the handler then refuses on the POST that follows.
    if (url.pathname === "/mcp") {
      const res = await createMcpHandler(createServer, {
        route: "/mcp",
        corsOptions: MCP_CORS,
        allowedOriginHostnames: MCP_ALLOWED_ORIGIN_HOSTNAMES,
      })(request, env, ctx);
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
    if (url.pathname === "/" || url.pathname === "/.well-known/mcp") {
      return withHeaders(new Response(
        JSON.stringify({ name: "turva-mcp", transport: "streamable-http", endpoint: "https://mcp.turva.dev/mcp" }),
        { headers: { "Content-Type": "application/json" } },
      ));
    }
    if (url.pathname === "/.well-known/glama.json") {
      return withHeaders(new Response(
        JSON.stringify({ "$schema": "https://glama.ai/mcp/schemas/connector.json", maintainers: [{ email: "info@turva.dev" }] }),
        { headers: { "Content-Type": "application/json" } },
      ));
    }
    return withHeaders(new Response("Not found", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
