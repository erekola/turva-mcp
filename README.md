````markdown
# turva-mcp

Public, read-only Model Context Protocol (MCP) server for [turva.dev](https://turva.dev), an agent-readiness audit service. It lets AI agents query turva.dev&#x27;s service catalog, its own agent-readiness scores, the public web-security scan results for its domain, and its engagement principles, as structured JSON instead of scraped HTML.

The server is public on purpose: anyone can read exactly what it exposes before deciding anything.

## Endpoint
```
https://mcp.turva.dev/mcp
```

Transport is Streamable HTTP. The MCP endpoint is `POST /mcp`; there is no SSE transport. A server card is published at `GET /` and `GET /.well-known/mcp`. CORS is open (`Access-Control-Allow-Origin: *`).

No authentication and no API key are required. All exposed data is public and read-only.

## Tools

Four read-only tools. There are no write tools and no transaction tools. Each returns JSON as text content.

| Tool | Returns |
|---|---|
| `get_services` | The service catalog (audit, advisory, implementation, MCP server design, workshops), the engagement model, and the pricing model (quote on request) |
| `get_agent_readiness` | turva.dev&#x27;s own agent-readiness scores from independent scanners, with the measurement date and verification links |
| `get_security_evidence` | Public web-security scan results for turva.dev&#x27;s own domain (Internet.nl, Hardenize), with the scan date |
| `get_principles` | The engagement principles: async-only, least access, results measured in scanner numbers, open and verifiable |

Data is served from static TypeScript objects bundled with the Worker, so every response is deterministic and depends on no external state. Scores carry a `measured_at` date and verification links, so any reader can compare a stored snapshot against a fresh scan.

## Endpoints

| Method and path | Response |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP |
| `GET /` | Server card JSON (`name`, `transport`, `endpoint`) |
| `GET /.well-known/mcp` | Server card JSON |
| `OPTIONS *` | `204` CORS preflight |
| any other path | `404` |

## Connect

Point any MCP client that supports Streamable HTTP at the endpoint. Example client config:

```json
{
  "mcpServers": {
    "turva": {
      "url": "https://mcp.turva.dev/mcp"
    }
  }
}
```

Quick reachability check from PowerShell (returns the server card):

```powershell
curl.exe https://mcp.turva.dev/
```

## Verify

Everything the tools return is publicly auditable. Re-run the scans and open the records yourself:

- StartupHub leaderboard: https://www.startuphub.ai/agent-readiness
- isitagentready scan: https://isitagentready.com/turva.dev
- Internet.nl report: https://internet.nl/site/turva.dev/
- Hardenize report: https://www.hardenize.com/report/turva.dev/
- Company (Finnish Business Information System): https://tietopalvelu.ytj.fi/yritys/3600281-7

## How it works

A single Cloudflare Worker built on the Cloudflare Agents SDK serves the MCP endpoint, backed by a Durable Object. Tool data lives in static TypeScript objects in the bundle. The server does no logging; errors are returned as MCP protocol error responses rather than written anywhere.

The Worker is independent from the main turva.dev site, so an MCP change cannot affect the website.

## Deploy

Requires a Cloudflare account and the `wrangler` CLI.

```powershell
cd turva-mcp
npm install
npx wrangler deploy
```

Route the Worker to `mcp.turva.dev` under **Workers &amp; Pages, your-worker, Settings, Domains &amp; Routes**.

## Use it for your own site

MIT licensed. Fork it, replace the static data objects with your own, deploy.

If you want an agent-readiness audit of your own domain, see [turva.dev](https://turva.dev) or [Erik Rekola on LinkedIn](https://www.linkedin.com/in/erikrekola).

## Security

Responsible disclosure: see [SECURITY.md](SECURITY.md). Contact: <mailto:info@turva.dev>

## License

[MIT](LICENSE)
````
