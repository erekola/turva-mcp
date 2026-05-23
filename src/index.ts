import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVICES = {
  pricing_model: "quote_on_request",
  pricing_note: "Hinnoittelu räätälöidään tarpeen mukaan. Pyydä tarjous: turva.dev",
  services: [
    {
      id: "guided-self-service",
      name: "Ohjattu omatoiminen tietoturvan parantaminen",
      summary: "Käymme asiakkaan kanssa läpi hänen oman laitteensa ja tilinsä tietoturva-asetukset. Asiakas tekee muutokset itse, me ohjaamme.",
      includes: [
        "Selain- ja käyttöjärjestelmäasetusten läpikäynti",
        "Salasanahallinnan käyttöönotto",
        "Monivaiheisen tunnistautumisen käyttöönotto",
        "Tilien tietoturvan kovennus",
      ],
      excludes: [
        "Etäyhteyden ottaminen asiakkaan laitteeseen",
        "Salasanojen kysyminen tai käsittely",
        "Asiakkaan puolesta kirjautuminen",
      ],
    },
  ],
} as const;

const SECURITY_EVIDENCE = {
  domain: "turva.dev",
  measured_at: "2026-05-23",
  scans: [
    { provider: "Internet.nl", score: 98, scale: "0-100", url: "https://internet.nl/site/turva.dev/" },
    { provider: "Hardenize", score: "13/13", scale: "categories passed", url: "https://www.hardenize.com/report/turva.dev/" },
  ],
  note: "Julkaisemme oman verkkotunnuksemme skannaustulokset todisteena siitä, että noudatamme samoja periaatteita joita opetamme asiakkaille.",
} as const;

const PRINCIPLES = {
  model: "guided_self_service",
  rules: [
    { id: "no-password-sharing", title: "Emme koskaan kysy asiakkaan salasanoja", rationale: "Salasana on henkilökohtainen. Asiakas syöttää sen aina itse." },
    { id: "no-remote-access", title: "Emme ota etäyhteyttä asiakkaan laitteeseen", rationale: "Asiakas pysyy hallinnassa. Ohjaamme, asiakas tekee." },
    { id: "satisfaction-guarantee", title: "100 % tyytyväisyystakuu", rationale: "Jos et koe saaneesi vastinetta, et maksa. Rahat takaisin -periaate." },
    { id: "transparency", title: "Avoin ja todennettava tietoturva", rationale: "Oman verkkotunnuksemme tietoturva on julkisesti skannattavissa." },
  ],
} as const;

export class TurvaMCP extends McpAgent {
  server = new McpServer({ name: "turva-mcp", version: "1.0.0" });

  async init() {
    this.server.tool(
      "get_services",
      "Palauttaa turva.dev:n palvelukatalogin: palvelut, mitä kuhunkin sisältyy ja mitä ei, sekä hinnoittelumalli (tarjouspyyntö).",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify(SERVICES, null, 2) }] }),
    );
    this.server.tool(
      "get_security_evidence",
      "Palauttaa turva.dev:n oman verkkotunnuksen tuoreimmat julkiset tietoturvaskannien tulokset (Internet.nl, Hardenize).",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify(SECURITY_EVIDENCE, null, 2) }] }),
    );
    this.server.tool(
      "get_principles",
      "Palauttaa turva.dev:n palvelumallin periaatteet: ohjattu omatoimisuus, ei salasanojen jakamista, ei etäyhteyttä, tyytyväisyystakuu.",
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
