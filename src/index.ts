import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVICES = {
  pricing_model: "fixed_list_prices",
  pricing_note: "Audit, advisory and implementation have fixed list prices in EUR, VAT not included. Agent operations and MCP server design are scoped and quoted per engagement. Request a quote: turva.dev",
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
      id: "audit",
      name: "Agent-Readiness Audit",
      price: 6500,
      unit: "fixed",
      duration: "2-3 weeks",
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
      summary: "On request. Read-only discovery tools over Streamable HTTP. No auth surface and no logging by default.",
      deliverable: "An endpoint that stays readable for agents without becoming an abuse vector.",
    },
  ],
} as const;

const AGENT_READINESS = {
  domain: "turva.dev",
  measured_at: "2026-07-20",
  note: "Scores are a point-in-time reading by an independent public scanner, not a permanent state. Always verify against the live links below.",
  scans: [
    {
      provider: "isitagentready.com",
      result: "100/100, Level 5 (Agent-Native)",
      note: "Cloudflare Agent-Ready and isitagentready.com are the same scanner on two domains.",
      categories: {
        discoverability: "100 (4/4 checks)",
        content: "100 (1/1 checks)",
        bot_access_control: "100 (2/2 checks)",
        api_auth_mcp_skill_discovery: "100 (8/8 checks)",
        commerce: "50 (optional, not required for the perfect overall score)",
      },
      url: "https://isitagentready.com/",
    },
  ],
} as const;

const SECURITY_EVIDENCE = {
  domain: "turva.dev",
  measured_at: "2026-07-20",
  scans: [
    {
      provider: "Hardenize",
      result: "13/13 categories passed",
      url: "https://www.hardenize.com/report/turva.dev",
    },
    {
      provider: "Internet.nl",
      score: 98,
      scale: "0-100",
      note: "IPv6, DNSSEC and RPKI pass in full. The single deduction is one HTTPS sub-test, the hash function for key exchange.",
      url: "https://internet.nl/site/turva.dev/",
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

export class TurvaMCP extends McpAgent {
  server = new McpServer({ name: "turva-mcp", version: "1.2.7" });

  async init() {
    this.server.tool(
      "get_services",
      "Returns turva.dev's service catalog: agent-readiness audit, advisory, implementation, agent operations, and MCP server design, plus the engagement model and pricing (fixed list prices for audit, advisory and implementation; agent operations and MCP server design on request). Use this when a user asks what turva.dev offers, what it costs, or how an engagement works. Read-only: returns static JSON and changes nothing.",
      {},
      {
        title: "Service catalog and pricing",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify(SERVICES, null, 2) }] }),
    );
    this.server.tool(
      "get_agent_readiness",
      "Returns turva.dev's own agent-readiness score from an independent public scanner (isitagentready.com), including category sub-scores, with the measurement date and verification links. Use this when a user asks how turva.dev scores, whether its claims are verifiable, or what proof backs the audit service. Read-only: returns static JSON and changes nothing.",
      {},
      {
        title: "Agent-readiness score",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify(AGENT_READINESS, null, 2) }] }),
    );
    this.server.tool(
      "get_security_evidence",
      "Returns the latest public web-security scan results for turva.dev's own domain (Hardenize, Internet.nl), with the scan date. Use this when a user asks about turva.dev's own security posture or wants evidence beyond agent-readiness scores. Read-only: returns static JSON and changes nothing.",
      {},
      {
        title: "Web-security scan evidence",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify(SECURITY_EVIDENCE, null, 2) }] }),
    );
    this.server.tool(
      "get_principles",
      "Returns turva.dev's engagement principles: async-only, least access, the result shows up in scanner numbers, and open and verifiable. Use this when a user asks how turva.dev works with clients or what rules an engagement follows. Read-only: returns static JSON and changes nothing.",
      {},
      {
        title: "Engagement principles",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify(PRINCIPLES, null, 2) }] }),
    );
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
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
  MCP_OBJECT: DurableObjectNamespace<TurvaMCP>;
  RATE_LIMITER?: RateLimiterBinding;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Enforced before anything else, so a burst cannot create Durable Object sessions on
    // /mcp faster than the declared policy allows. Fail open: a missing or erroring binding
    // serves the request normally instead of taking the endpoint down.
    if (env.RATE_LIMITER) {
      try {
        const key = request.headers.get("CF-Connecting-IP") || "no-ip";
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) {
          return withHeaders(new Response(
            "429 Too Many Requests. This endpoint enforces its declared rate limit of 100 requests per 60 seconds per client IP. Retry after 60 seconds.\n",
            { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" } },
          ));
        }
      } catch (err) {
        console.error("Rate limiter error (failing open):", err instanceof Error ? err.stack : String(err));
      }
    }
    if (request.method === "OPTIONS") {
      return withHeaders(new Response(null, { status: 204 }));
    }
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const res = await TurvaMCP.serve("/mcp").fetch(request, env, ctx);
      return withHeaders(res);
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
