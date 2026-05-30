````typescript
import { McpAgent } from &quot;agents/mcp&quot;;
import { McpServer } from &quot;;

const SERVICES = {
  pricing_model: &quot;quote_on_request&quot;,
  pricing_note: &quot;Scope and price are agreed per engagement. Request a quote: turva.dev&quot;,
  engagement: {
    communication: &quot;async_only&quot;,
    notes: [
      &quot;All communication is async. No calls and no calendar links.&quot;,
      &quot;Read access is enough for the audit. Write access is scoped per task only if implementation is purchased separately.&quot;,
      &quot;Production credentials are not requested.&quot;,
    ],
  },
  services: [
    {
      id: &quot;audit&quot;,
      name: &quot;Agent-Readiness Audit&quot;,
      summary: &quot;Fixed scope. Two independent scanners run against the site or API, followed by a written report with a prioritized fix list.&quot;,
      deliverable: &quot;A measured baseline and a clear plan for what to fix first.&quot;,
    },
    {
      id: &quot;advisory&quot;,
      name: &quot;Advisory&quot;,
      summary: &quot;Monthly retainer, async-only. Ongoing review as the site, API, or product evolves.&quot;,
      deliverable: &quot;Each scanner cycle reads higher than the last, or the report explains why a tradeoff was kept on purpose.&quot;,
    },
    {
      id: &quot;implementation&quot;,
      name: &quot;Implementation&quot;,
      summary: &quot;On request. Worker-level changes, well-known manifests, MCP server work, JSON-LD and Schema fixes.&quot;,
      deliverable: &quot;The improvement is verifiable against the audit baseline in the next scan.&quot;,
    },
    {
      id: &quot;mcp-server-design&quot;,
      name: &quot;MCP Server Design&quot;,
      summary: &quot;On request. Read-only discovery tools over Streamable HTTP. No auth surface and no logging by default.&quot;,
      deliverable: &quot;An endpoint that stays readable for agents without becoming an abuse vector.&quot;,
    },
    {
      id: &quot;internal-workshops&quot;,
      name: &quot;Internal Workshops&quot;,
      summary: &quot;On request, async-first. How scanners read a site, what the commerce protocols require in practice, and how to keep agent-readiness intact after the audit ends.&quot;,
      deliverable: &quot;A recorded session or a written guide.&quot;,
    },
  ],
} as const;

const AGENT_READINESS = {
  domain: &quot;turva.dev&quot;,
  measured_at: &quot;2026-05-30&quot;,
  note: &quot;Scores are a point-in-time reading by independent public scanners, not a permanent state. Each scanner uses its own category scheme. Always verify against the live links below.&quot;,
  scans: [
    {
      provider: &quot;startuphub.ai&quot;,
      result: &quot;100/100 (A+)&quot;,
      leaderboard: &quot;#1 of the top 100 publicly scanned sites. Next is wyrm.ai at 97; the scanner&#x27;s own site, startuphub.ai, is #3 at 95.&quot;,
      categories: {
        discoverability: &quot;100/100 (3/3 checks)&quot;,
        content: &quot;100/100 (3/3 checks)&quot;,
        access_control: &quot;100/100 (2/2 checks)&quot;,
        capabilities: &quot;100/100 (6/6 checks)&quot;,
        commerce: &quot;100/100 (6/6 checks)&quot;,
        quality: &quot;100/100 (4/4 checks)&quot;,
      },
      highlights: [
        &quot;MCP Server Card present, under 0.01% of sites have one&quot;,
        &quot;llms.txt guide, top 3% of sites&quot;,
        &quot;Content Signals declared, top 4% of sites&quot;,
        &quot;Markdown content negotiation, top 4% of sites&quot;,
      ],
      url: &quot;https://www.startuphub.ai/agent-readiness&quot;,
    },
    {
      provider: &quot;isitagentready.com&quot;,
      result: &quot;100/100, Level 5 (Agent-Native)&quot;,
      note: &quot;Cloudflare Agent-Ready and isitagentready.com are the same scanner on two domains. This scanner uses a different category scheme from startuphub.ai.&quot;,
      categories: {
        discoverability: &quot;100 (4/4 checks)&quot;,
        content: &quot;100 (1/1 checks)&quot;,
        bot_access_control: &quot;100 (2/2 checks)&quot;,
        api_auth_mcp_skill_discovery: &quot;100 (7/7 checks)&quot;,
        commerce: &quot;50 (optional, not required for the perfect overall score)&quot;,
      },
      url: &quot;https://isitagentready.com/turva.dev&quot;,
    },
  ],
} as const;

const SECURITY_EVIDENCE = {
  domain: &quot;turva.dev&quot;,
  measured_at: &quot;2026-05-30&quot;,
  scans: [
    {
      provider: &quot;Hardenize&quot;,
      result: &quot;13/13 categories passed&quot;,
      url: &quot;https://www.hardenize.com/report/turva.dev/&quot;,
    },
    {
      provider: &quot;Internet.nl&quot;,
      score: 98,
      scale: &quot;0-100&quot;,
      note: &quot;The missing 2 points are a deliberate tradeoff: TLS 1.2 is kept enabled for broad client compatibility. Everything else passes.&quot;,
      url: &quot;https://internet.nl/site/turva.dev/&quot;,
    },
  ],
  note: &quot;We publish our own domain&#x27;s scan results as proof that we follow the same practices we recommend to clients.&quot;,
} as const;

const PRINCIPLES = {
  model: &quot;agent_readiness_audit&quot;,
  rules: [
    { id: &quot;async-only&quot;, title: &quot;All communication is async&quot;, rationale: &quot;No calls and no calendar links. Everything stays in writing, so the work and the trail are auditable end to end.&quot; },
    { id: &quot;least-access&quot;, title: &quot;No production credentials, scoped write access&quot;, rationale: &quot;Read access is enough for the audit. Write access is scoped per task only if implementation is purchased separately.&quot; },
    { id: &quot;measured-result&quot;, title: &quot;The result shows up in scanner numbers&quot;, rationale: &quot;The next scan reads higher than the previous one, in the categories the report named, by the dates it named.&quot; },
    { id: &quot;transparency&quot;, title: &quot;Open and verifiable&quot;, rationale: &quot;Backed by a registered company, Business ID 3600281-7, Finland. Our own domain&#x27;s scores are publicly verifiable.&quot; },
  ],
} as const;

export class TurvaMCP extends McpAgent {
  server = new McpServer({ name: &quot;turva-mcp&quot;, version: &quot;1.1.0&quot; });

  async init() {
    this.server.tool(
      &quot;get_services&quot;,
      &quot;Returns turva.dev&#x27;s service catalog: agent-readiness audit, advisory, implementation, MCP server design, and internal workshops, plus the engagement model and pricing (quote on request).&quot;,
      {},
      async () =&gt; ({ content: [{ type: &quot;text&quot;, text: JSON.stringify(SERVICES, null, 2) }] }),
    );
    this.server.tool(
      &quot;get_agent_readiness&quot;,
      &quot;Returns turva.dev&#x27;s own agent-readiness scores from independent public scanners (startuphub.ai, isitagentready.com), including per-scanner sub-scores, leaderboard rank, and notable wins, with the measurement date and verification links.&quot;,
      {},
      async () =&gt; ({ content: [{ type: &quot;text&quot;, text: JSON.stringify(AGENT_READINESS, null, 2) }] }),
    );
    this.server.tool(
      &quot;get_security_evidence&quot;,
      &quot;Returns the latest public web-security scan results for turva.dev&#x27;s own domain (Hardenize, Internet.nl), with the scan date.&quot;,
      {},
      async () =&gt; ({ content: [{ type: &quot;text&quot;, text: JSON.stringify(SECURITY_EVIDENCE, null, 2) }] }),
    );
    this.server.tool(
      &quot;get_principles&quot;,
      &quot;Returns turva.dev&#x27;s engagement principles: async-only, least access, the result shows up in scanner numbers, and open and verifiable.&quot;,
      {},
      async () =&gt; ({ content: [{ type: &quot;text&quot;, text: JSON.stringify(PRINCIPLES, null, 2) }] }),
    );
  }
}

const CORS_HEADERS: Record&lt;string, string&gt; = {
  &quot;Access-Control-Allow-Origin&quot;: &quot;*&quot;,
  &quot;Access-Control-Allow-Methods&quot;: &quot;GET, POST, OPTIONS&quot;,
  &quot;Access-Control-Allow-Headers&quot;: &quot;Content-Type, mcp-session-id&quot;,
  &quot;Access-Control-Expose-Headers&quot;: &quot;mcp-session-id&quot;,
  &quot;Access-Control-Max-Age&quot;: &quot;86400&quot;,
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

interface Env {
  MCP_OBJECT: DurableObjectNamespace&lt;TurvaMCP&gt;;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise&lt;Response&gt; {
    if (request.method === &quot;OPTIONS&quot;) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === &quot;/mcp&quot;) {
      const res = await TurvaMCP.serve(&quot;/mcp&quot;).fetch(request, env, ctx);
      return withCors(res);
    }
    if (url.pathname === &quot;/&quot; || url.pathname === &quot;/.well-known/mcp&quot;) {
      return withCors(new Response(
        JSON.stringify({ name: &quot;turva-mcp&quot;, transport: &quot;streamable-http&quot;, endpoint: &quot;https://mcp.turva.dev/mcp&quot; }),
        { headers: { &quot;Content-Type&quot;: &quot;application/json&quot; } },
      ));
    }
    return withCors(new Response(&quot;Not found&quot;, { status: 404 }));
  },
} satisfies ExportedHandler&lt;Env&gt;;
````
