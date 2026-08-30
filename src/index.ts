import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

const SERVICES = {
  pricing_model: "fixed_list_prices",
  pricing_note: "The Shopify agent storefront check, audit, advisory and implementation have fixed list prices in EUR, VAT not included. Agent operations and MCP server design are scoped and quoted per engagement. Request a quote: turva.dev",
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
      price: 1900,
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
      deliverable: "A measured baseline and a clear plan for what to fix first.",
    },
    {
      id: "advisory",
      name: "Advisory",
      price: 3000,
      unit: "month",
      minimum_commitment: "3 months",
      summary: "Monthly retainer, async-only. Ongoing review as the site, API, or product evolves.",
      deliverable: "Each scanner cycle reads higher than the last, or the report explains why a tradeoff was kept on purpose.",
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
} as const;

const AGENT_READINESS = {
  domain: "turva.dev",
  measured_at: "2026-08-30",
  note: "Scores are a point-in-time reading by an independent public scanner, not a permanent state. Always verify against the live links below.",
  scans: [
    {
      provider: "isitagentready.com",
      result: "100/100, Level 5 (Agent-Native)",
      note: "Cloudflare Agent-Ready and isitagentready.com are the same scanner on two domains.",
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
  measured_at: "2026-08-28",
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
    { id: "measured-result", title: "The result shows up in scanner numbers", rationale: "The next scan reads higher than the previous one, in the categories the report named, by the dates it named." },
    { id: "transparency", title: "Open and verifiable", rationale: "Backed by a registered business, Business ID 3600281-7, Finland. Our own domain's scores are publicly verifiable." },
  ],
} as const;

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Read-only annotations, identical on all four tools. Declared once so the four
// registrations cannot drift apart, which is the same failure class the signed
// server card has already produced twice.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// A fresh server per request. The 2026-07-28 revision is stateless: there is no
// initialize handshake, no Mcp-Session-Id and no session to keep alive, so nothing
// here is shared between requests and no Durable Object is needed. server/discover
// is installed by the SDK itself and is deliberately not implemented by hand.
function createServer(): McpServer {
  const server = new McpServer(
    { name: "turva-mcp", version: "1.3.6" },
    {
      // The revision requires ttlMs and cacheScope on every cacheable result. The SDK
      // would default them to 0 and private. These four tools are static data compiled
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
      description: "Returns turva.dev's service catalog: the Shopify agent storefront check, agent-readiness audit, advisory, implementation, agent operations, and MCP server design, plus the engagement model and pricing (fixed list prices for the Shopify agent storefront check, audit, advisory and implementation; agent operations and MCP server design on request). Use this when a user asks what turva.dev offers, what it costs, or how an engagement works. Read-only: returns static JSON and changes nothing.",
      annotations: READ_ONLY,
    },
    async () => textResult(SERVICES),
  );

  server.registerTool(
    "get_agent_readiness",
    {
      title: "Agent-readiness score",
      description: "Returns turva.dev's own agent-readiness score from an independent public scanner (isitagentready.com), including category sub-scores, with the measurement date and verification links. Use this when a user asks how turva.dev scores, whether its claims are verifiable, or what proof backs the audit service. Read-only: returns static JSON and changes nothing.",
      annotations: READ_ONLY,
    },
    async () => textResult(AGENT_READINESS),
  );

  server.registerTool(
    "get_security_evidence",
    {
      title: "Web-security scan evidence",
      description: "Returns the latest public web-security scan results for turva.dev's own domain (Hardenize, Internet.nl), with the scan date. Use this when a user asks about turva.dev's own security posture or wants evidence beyond agent-readiness scores. Read-only: returns static JSON and changes nothing.",
      annotations: READ_ONLY,
    },
    async () => textResult(SECURITY_EVIDENCE),
  );

  server.registerTool(
    "get_principles",
    {
      title: "Engagement principles",
      description: "Returns turva.dev's engagement principles: async-only, least access, the result shows up in scanner numbers, and open and verifiable. Use this when a user asks how turva.dev works with clients or what rules an engagement follows. Read-only: returns static JSON and changes nothing.",
      annotations: READ_ONLY,
    },
    async () => textResult(PRINCIPLES),
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
