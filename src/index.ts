import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVICES = {
  pricing_model: "quote_on_request",
  pricing_note: "Scope and price are agreed per engagement. Request a quote: turva.dev",
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
      summary: "Fixed scope. Two independent scanners run against the site or API, followed by a written report with a prioritized fix list.",
      deliverable: "A measured baseline and a clear plan for what to fix first.",
    },
    {
      id: "advisory",
      name: "Advisory",
      summary: "Monthly retainer, async-only. Ongoing review as the site, API, or product evolves.",
      deliverable: "Each scanner cycle reads higher than the last, or the report explains why a tradeoff was kept on purpose.",
    },
    {
      id: "implementation",
      name: "Implementation",
      summary: "On request. Worker-level changes, well-known manifests, MCP server work, JSON-LD and Schema fixes.",
      deliverable: "The improvement is verifiable against the audit baseline in the next scan.",
    },
    {
      id: "mcp-server-design",
      name: "MCP Server Design",
      summary: "On request. Read-only discovery tools over Streamable HTTP. No auth surface and no logging by default.",
      deliverable: "An endpoint that stays readable for agents without becoming an abuse vector.",
    },
    {
      id: "internal-workshops",
      name: "Internal Workshops",
      summary: "On request, async-first. How scanners read a site, what the commerce protocols require in practice, and how to keep agent-readiness intact after the audit ends.",
      deliverable: "A recorded session or a written guide.",
    },
  ],
} as const;

const AGENT_READINESS = {
  domain: "turva.dev",
  measured_at: "2026-05-30",
  note: "Scores are a point-in-time reading by independent public scanners, not a permanent state. Each scanner uses its own category scheme. Always verify against the live links below.",
  scans: [
    {
      provider: "startuphub.ai",
      result: "100/100 (A+)",
      leaderboard: "#1 of the top 100 publicly scanned sites. Next is wyrm.ai at 97; the scanner's own site, startuphub.ai, is #3 at 95.",
      categories: {
        discoverability: "100/100 (3/3 checks)",
        content: "100/100 (3/3 checks)",
        access_control: "100/100 (2/2 checks)",
        capabilities: "100/100 (6/6 checks)",
        commerce: "100/100 (6/6 checks)",
        quality: "100/100 (4/4 checks)",
      },
      highlights: [
        "MCP Server Card present, under 0.01% of sites have one",
        "llms.txt guide, top 3% of sites",
        "Content Signals declared, top 4% of sites",
        "Markdown content negotiation, top 4% of sites",
      ],
      url: "https://www.startuphub.ai/agent-readiness",
    },
    {
      provider: "isitagentready.com",
      result: "100/100, Level 5 (Agent-Native)",
      note: "Cloudflare Agent-Ready and isitagentready.com are the same scanner on two domains. This scanner uses a different category scheme from startuphub.ai.",
      categories: {
        discoverability: "100 (4/4 checks)",
        content: "100 (1/1 checks)",
        bot_access_control: "100 (2/2 checks)",
        api_auth_mcp_skill_discovery: "100 (7/7 checks)",
        commerce: "50 (optional, not required for the perfect overall score)",
      },
      url: "https://isitagentready.com/turva.dev",
    },
  ],
} as const;

const SECURITY_EVIDENCE = {
  domain: "turva.dev",
  measured_at: "2026-05-30",
  scans: [
    {
      provider: "Hardenize",
      result: "13/13 categories passed",
      url: "https://www.hardenize.com/report/turva.dev/",
    },
    {
      provider: "Internet.nl",
      score: 98,
      scale: "0-100",
      note: "The missing 2 points are a deliberate tradeoff: TLS 1.2 is kept enabled for broad client compatibility. Everything else passes.",
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
    { id: "transparency", title: "Open and verifiable", rationale: "Backed by a registered company, Business ID 3600281-7, Finland. Our own domain's scores are publicly verifiable." },
  ],
} as const;

export class TurvaMCP extends McpAgent {
  server = new McpServer({ name: "turva-mcp", version: "1.1.0" });

  async init() {
    this.server.tool(
      "get_services",
      "Returns turva.dev's service catalog: agent-readiness audit, advisory, implementation, MCP server design, and internal workshops, plus the engagement model and pricing (quote on request).",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify(SERVICES, null, 2) }] }),
    );
    this.server.tool(
      "get_agent_readiness",
      "Returns turva.dev's own agent-readiness scores from independent public scanners (startuphub.ai, isitagentready.com), including per-scanner sub-scores, leaderboard rank, and notable wins, with the measurement date and verification links.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify(AGENT_READINESS, null, 2) }] }),
    );
    this.server.tool(
      "get_security_evidence",
      "Returns the latest public web-security scan results for turva.dev's own domain (Hardenize, Internet.nl), with the scan date.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify(SECURITY_EVIDENCE, null, 2) }] }),
    );
    this.server.tool(
      "get_principles",
      "Returns turva.dev's engagement principles: async-only, least access, the result shows up in scanner numbers, and open and verifiable.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify(PRINCIPLES, null, 2) }] }),
    );
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

interface Env {
  MCP_OBJECT: DurableObjectNamespace<TurvaMCP>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const res = await TurvaMCP.serve("/mcp").fetch(request, env, ctx);
      return withCors(res);
    }
    if (url.pathname === "/" || url.pathname === "/.well-known/mcp") {
      return withCors(new Response(
        JSON.stringify({ name: "turva-mcp", transport: "streamable-http", endpoint: "https://mcp.turva.dev/mcp" }),
        { headers: { "Content-Type": "application/json" } },
      ));
    }
    return withCors(new Response("Not found", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
