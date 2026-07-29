# turva-mcp

Public, read-only Model Context Protocol (MCP) server for [turva.dev](https://turva.dev), an agent-readiness audit and advisory service. It lets AI agents query turva.dev's service catalog, its own agent-readiness scores, the public web-security scan results for its domain, and its engagement principles, as structured JSON instead of scraped HTML.

The server is public on purpose: anyone can read exactly what it exposes before deciding anything.

## MCP endpoint
```
https://mcp.turva.dev/mcp
```

Listed in the official MCP registry as `dev.turva/turva-mcp`, and in the Glama MCP directory (domain verified at `/.well-known/glama.json`).

Implements MCP protocol revision 2026-07-28. The SDK's legacy lane is left at its default, so a client on an older revision still works at the same endpoint. Transport is Streamable HTTP and the MCP endpoint is `POST /mcp`. The deprecated standalone SSE transport is not served.

Revision 2026-07-28 removed protocol sessions and the `initialize` handshake, so there is no session id and nothing to tear down. Each request carries the protocol revision and the client's capabilities in `params._meta`, and the `MCP-Protocol-Version` header names the revision. `server/discover` reports what this server supports. A server card is published at `GET /` and `GET /.well-known/mcp`.

CORS differs by path on purpose. `/mcp` allows the browser origins `https://turva.dev` and `https://mcp.turva.dev` only, and answers `403` to any other origin; agents send no `Origin` header at all, so this restricts browser clients rather than agents. The card and discovery paths keep open CORS (`Access-Control-Allow-Origin: *`), because directories read them.

No authentication and no API key are required. All exposed data is public and read-only. Requests are rate limited to 100 per 60 seconds per client IP at the edge, answered with `429` and a `Retry-After` header past that, and the limiter fails open if it errors.

## Tools

Four read-only tools. There are no write tools and no transaction tools. Each returns JSON as text content.

- `get_services`: the service catalog (audit, advisory, implementation, agent operations, MCP server design), the engagement model, and pricing (fixed list prices for audit, advisory and implementation, others on request).
- `get_agent_readiness`: turva.dev's own agent-readiness score from an independent scanner, with category sub-scores, the measurement date, and verification links.
- `get_security_evidence`: public web-security scan results for turva.dev's own domain (Hardenize, Internet.nl), with the scan date.
- `get_principles`: the engagement principles, namely async-only, least access, results measured in scanner numbers, open and verifiable.

Data is served from static TypeScript objects bundled with the Worker, so every response is deterministic and depends on no external state. Scores carry a `measured_at` date and verification links, so any reader can compare a stored snapshot against a fresh scan.

## Evidence

The scores these tools return are turva.dev's own, measured by independent public scanners on 2026-07-28: 100/100 and Level 5 (Agent-Native) on isitagentready.com, Hardenize passing all 13 categories, and 98/100 on Internet.nl. Every response carries a `measured_at` date and a verification link, so a stored snapshot can be compared against a fresh scan. Re-run any scan yourself from the links in Verify below.

## Endpoints

| Method and path | Response |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP |
| `GET /mcp`, `DELETE /mcp` | `405`, no GET stream and no sessions since revision 2026-07-28 |
| `GET /` | Server card JSON (`name`, `transport`, `endpoint`) |
| `GET /.well-known/mcp` | Server card JSON |
| `GET /.well-known/glama.json` | Glama MCP directory domain verification |
| `OPTIONS *` | `204` CORS preflight |
| any other path | `404` |

`GET` and `DELETE` on `/mcp` answer `405`: the GET stream and session termination went away with sessions in revision 2026-07-28. If the `Mcp-Method` header and the request body name different methods, the request is refused with `400` and error code `-32020`. A method this server does not declare, such as `resources/list`, answers `404` with `-32601` rather than an empty success. The card paths respond to any method.

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

Quick reachability check (returns the server card):

```
curl https://mcp.turva.dev/
```

On Windows PowerShell use `curl.exe`, since `curl` is an alias for Invoke-WebRequest.

## Verify

Everything the tools return is publicly auditable. Re-run the scans and open the records yourself:

- isitagentready scanner: https://isitagentready.com/
- Hardenize report: https://www.hardenize.com/report/turva.dev
- Internet.nl report: https://internet.nl/site/turva.dev/
- Company (Finnish Business Information System): https://tietopalvelu.ytj.fi/yritys/3600281-7

## How it works

A single Cloudflare Worker built on the Cloudflare Agents SDK serves the MCP endpoint through `createMcpHandler`. There is no Durable Object: the stateful implementation needed one, and it was deleted with the 2026-07-28 migration because the protocol no longer has sessions. Tool data lives in static TypeScript objects in the bundle. The server does no logging. Errors are returned as MCP protocol error responses rather than written anywhere. Cloudflare Workers observability is switched off in `wrangler.jsonc`, so the platform does not collect invocation logs either.

The Worker is independent from the main turva.dev site, so an MCP change cannot affect the website.

## Deploy

Requires a Cloudflare account and the `wrangler` CLI.

```powershell
cd turva-mcp
npm install
npx wrangler deploy
```

Route the Worker to `mcp.turva.dev` under **Workers & Pages, your-worker, Settings, Domains & Routes**.

## Use it for your own site

MIT licensed. Fork it, replace the static data objects with your own, then deploy.

If you want an agent-readiness audit of your own domain, see [turva.dev](https://turva.dev) or [Erik Rekola on LinkedIn](https://www.linkedin.com/in/erikrekola).

## Security

Responsible disclosure: see [SECURITY.md](SECURITY.md). Contact: [info@turva.dev](mailto:info@turva.dev)

## License

[MIT](LICENSE)
