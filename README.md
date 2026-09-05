# turva-mcp

A public, read-only Model Context Protocol (MCP) server for [turva.dev](https://turva.dev).

It gives compatible AI clients structured access to turva.dev's service catalog, agent-readiness evidence, public web-security evidence and engagement principles. The server answers questions about turva.dev itself. It does not scan another domain, run an audit or perform transactions.

## Connect

Streamable HTTP endpoint:

```text
https://mcp.turva.dev/mcp
```

No authentication or API key is required. Set the endpoint in any MCP client with Streamable HTTP support. Clients that use a URL-based `mcpServers` configuration commonly accept this shape:

```json
{
  "mcpServers": {
    "turva": {
      "url": "https://mcp.turva.dev/mcp"
    }
  }
}
```

The endpoint expects MCP `POST` requests, so opening `/mcp` in a browser returns `405`. Check reachability through the discovery document instead:

```powershell
curl.exe https://mcp.turva.dev/
```

The server is listed in the official MCP registry as `dev.turva/turva-mcp` and in the Glama MCP directory.

## Tools

Four read-only tools, each idempotent and returning JSON as text content. There are no write tools and no transaction tools.

- `get_services`: the service catalog (Shopify agent storefront check, audit, advisory, implementation, agent operations and MCP server design), the engagement model, and pricing (four fixed list prices, the other two on request).
- `get_agent_readiness`: turva.dev's agent-readiness score, category scores, measurement date and verification link.
- `get_security_evidence`: public Hardenize and Internet.nl results for turva.dev, with their measurement date.
- `get_principles`: the async-only, least-access, measured-results and transparency principles.

## Evidence

Tool responses come from static TypeScript objects bundled with the Worker. They are deterministic and do not depend on a live upstream request.

The two measurement tools include a `measured_at` date and public verification links. Treat their values as point-in-time evidence and compare them with a fresh scan when current status matters.

The bundled snapshot records these results for **2026-09-01**:

- Agent readiness: **100/100, Level 5 (Agent-Native)** on [isitagentready.com](https://isitagentready.com/)
- Web security: **24/24 categories passed** on [Hardenize](https://www.hardenize.com/report/turva.dev)
- Website standards: **98/100** on [Internet.nl](https://internet.nl/site/turva.dev/)
- Mail standards: **95/100** on [Internet.nl](https://internet.nl/mail/turva.dev/)

These are third-party readings for turva.dev, not scores produced by this server.

## Endpoints

| Method and path | Behavior |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP |
| `GET /mcp`, `DELETE /mcp` | `405`. The server exposes no GET stream and no session teardown |
| `OPTIONS /mcp` | `200` for an accepted MCP preflight, `403` when the browser `Origin` is not allowed |
| `GET /` | Minimal discovery JSON with the server name, transport and endpoint |
| `GET /.well-known/mcp` | The same discovery JSON |
| `GET /.well-known/glama.json` | Glama domain-verification document |
| `OPTIONS` on any other path | `204` discovery CORS preflight |
| `POST`, `PUT`, `DELETE` or `PATCH` on any path other than `/mcp` | `405` with `Allow: GET, HEAD, OPTIONS` |
| `GET` or `HEAD` on any other path | `404` |

The full signed MCP server card is published at [turva.dev/.well-known/mcp/server-card.json](https://turva.dev/.well-known/mcp/server-card.json).

## Protocol and implementation

A single Cloudflare Worker built on the Cloudflare Agents SDK serves the endpoint through `createMcpHandler`. A fresh `McpServer` is created for each request, and there is no Durable Object or persistent MCP session.

The current protocol lane uses revision `2026-07-28`, and the SDK's legacy compatibility lane remains available at the same endpoint. On the current lane the handler validates `MCP-Protocol-Version` and `Mcp-Method`, plus `Mcp-Name` for `tools/call`. Standard MCP clients handle these details. `server/discover` is supplied by the SDK.

The discovery documents and tool data are compiled into the Worker. The MCP Worker is separate from the main turva.dev Worker, so changes here do not change the website.

## Security and operating limits

- Public and unauthenticated by design: every exposed value is already public.
- Read-only MCP annotations on every tool: no destructive or open-world operation is declared.
- Rate limit: 100 requests per 60 seconds per client IP, with `429` and `Retry-After: 60` after the limit. The endpoint fails open if the rate-limiter binding errors.
- Browser CORS on `/mcp`: `https://turva.dev` is the only allowed `Origin`, and the handler returns `403` for every other origin. Non-browser MCP clients normally send no `Origin` header and can connect directly. Discovery documents use open CORS so directories can read them.
- No application request log: the code does not store request bodies, client identities or tool inputs. Cloudflare Workers observability is disabled. A rate-limiter failure writes one diagnostic error without request data.
- Security headers are applied to MCP and discovery responses.

For private vulnerability reports, see [SECURITY.md](SECURITY.md) or email [info@turva.dev](mailto:info@turva.dev).

## Deploy your own copy

This repository is MIT licensed and can be adapted for another site. Before deploying a fork:

1. Replace the static service and evidence objects in `src/index.ts` with your own published data.
2. Replace the hard-coded `turva.dev` domain, MCP endpoint, browser origin and verification links with values you control.
3. Give the Worker a unique `name` and a rate-limit `namespace_id` that is not shared with another Worker in your Cloudflare account.
4. Attach your own custom domain. `workers_dev` is disabled in `wrangler.jsonc`, and `mcp.turva.dev` belongs to this deployment.

Then install, check and deploy with your Cloudflare account:

```powershell
cd turva-mcp
npm install
npm run typecheck
npx wrangler deploy
```

Configure the custom domain under **Workers & Pages, your Worker, Settings, Domains & Routes**. Use your own hostname and update the discovery endpoint in `src/index.ts` to match it.

## Verify the published claims

- [isitagentready.com scanner](https://isitagentready.com/)
- [Hardenize report](https://www.hardenize.com/report/turva.dev)
- [Internet.nl website report](https://internet.nl/site/turva.dev/)
- [Internet.nl mail report](https://internet.nl/mail/turva.dev/)
- [Finnish Business Information System record](https://tietopalvelu.ytj.fi/yritys/3600281-7)

If you want an agent-readiness audit of your own domain, see [turva.dev](https://turva.dev) or [Erik Rekola on LinkedIn](https://www.linkedin.com/in/erikrekola).

## License

[MIT](LICENSE)
