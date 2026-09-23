# turva-mcp

[![turva-mcp on Glama](https://glama.ai/mcp/connectors/dev.turva/turva-mcp/badges/score.svg)](https://glama.ai/mcp/connectors/dev.turva/turva-mcp)

A public, read-only Model Context Protocol server for [turva.dev](https://turva.dev). It lets an AI client look up the site's published information, including contact details and dated measurement evidence.

For example, a client can use `get_contact` when someone asks how to reach me. The reply explains how to start. The server answers questions about turva.dev itself. It does not scan another domain, run an audit or perform transactions.

## Connect

Streamable HTTP endpoint:

```text
https://mcp.turva.dev/mcp
```

Connect to the hosted server directly. No npm installation, authentication or API key is required. Set the endpoint in an MCP client with Streamable HTTP support. Clients that use a URL-based `mcpServers` configuration commonly accept this shape:

```json
{
  "mcpServers": {
    "turva": {
      "url": "https://mcp.turva.dev/mcp"
    }
  }
}
```

The endpoint expects MCP `POST` requests. Opening `/mcp` in a browser returns `405`. Check reachability through the discovery document instead:

```sh
curl https://mcp.turva.dev/
```

In Windows PowerShell, use `curl.exe` if `curl` resolves to `Invoke-WebRequest`.

The server is listed in the official MCP registry as `dev.turva/turva-mcp` and in the [Glama MCP directory](https://glama.ai/mcp/connectors/dev.turva/turva-mcp).

## Try a tool

Once connected, call `get_contact` with an empty argument object. In an MCP client SDK, the call is:

```js
const result = await client.callTool({ name: "get_contact", arguments: {} });
const contact = result.structuredContent;
console.log(contact.email, contact.first_reply);
```

Here `client` is your connected MCP client. The same JSON is also in `result.content[0].text` for clients that read text only. This excerpt from the response shows the contact fields maintained in [src/index.ts](src/index.ts):

```json
{
  "email": "info@turva.dev",
  "location": "Tampere, Finland",
  "engagement": "async_only",
  "first_reply": "Within one business day, in writing, by email or Signal. LinkedIn messages have no set reply time."
}
```

The full response also includes other contact channels and instructions for starting an engagement.

Without an SDK, a request on the current protocol lane needs four things beside the JSON-RPC body: the `MCP-Protocol-Version` header, the `Mcp-Method` header, the `Mcp-Name` header on `tools/call`, and a `_meta` object in `params` that names the protocol version and the client's capabilities. The same call with `curl`:

```sh
curl https://mcp.turva.dev/mcp \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: get_contact" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_contact","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The answer is one JSON-RPC response, and the contact data is in `result.structuredContent`.

## Tools

Five read-only tools, each idempotent. Each returns its data as `structuredContent`, which the tool's `outputSchema` describes, and as the same JSON in a text block. No tool takes arguments: the input schema allows none, and a call that passes one returns a tool error. There are no write tools or transaction tools.

| Tool | Returns |
| --- | --- |
| `get_services` | The engagement model, the service catalog (Shopify agent storefront check, audit, advisory, implementation, agent operations and MCP server design) and pricing (four fixed list prices and two on request), plus two implementation add-ons that carry a fixed price and are sold only with the diagnosis they follow |
| `get_agent_readiness` | turva.dev's agent-readiness score, category scores, measurement date and verification link |
| `get_security_evidence` | Public Hardenize and Internet.nl results for turva.dev, with their measurement date |
| `get_principles` | The principles covering written work, access and verification |
| `get_contact` | Contact channels, the first-reply time and what access an audit needs |

## Evidence

Tool responses come from static TypeScript objects bundled with the Worker. They do not depend on a live upstream request. The measurement tools include a `measured_at` date and public verification links, so compare the recorded values with a fresh scan when current status matters.

The bundled snapshot dated 2026-09-23 records 100/100, Level 5 Agent-Native on [isitagentready.com](https://isitagentready.com/), all 24 categories passed on [Hardenize](https://www.hardenize.com/report/turva.dev), 98/100 on the [Internet.nl website test](https://internet.nl/site/turva.dev/) and 90/100 on its [email test](https://internet.nl/mail/turva.dev/). These are third-party readings of turva.dev, not scores produced by this server.

## Endpoints

| Method and path | Behavior |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP. A body over 64 KiB receives `413`, and a JSON-RPC batch receives `400` with error `-32600` |
| `GET /mcp`, `DELETE /mcp` | `405` with `Allow: POST, OPTIONS`. No GET stream or session teardown |
| `OPTIONS /mcp` | `200` for an accepted MCP preflight, `403` when the browser `Origin` is not allowed |
| `/mcp/` | `308` to `/mcp`, keeping the method and the query string. A preflight `OPTIONS` is answered as the one for `/mcp`, because a browser does not follow a redirect on a preflight |
| `GET /` | Minimal discovery JSON with the server name, transport and endpoint |
| `GET /.well-known/mcp` | The same discovery JSON |
| `GET /.well-known/glama.json` | Glama domain-verification document |
| `OPTIONS` on any other path | `204` discovery CORS preflight |
| `POST`, `PUT`, `DELETE` or `PATCH` on any path other than `/mcp` and `/mcp/` | `405` with `Allow: GET, HEAD, OPTIONS` |
| `GET` or `HEAD` on any other path | `404` |

`HEAD` on a discovery document returns its headers without a body. The discovery documents carry `Cache-Control: public, max-age=3600`, the same hour that `tools/list` and `server/discover` declare.

The full signed MCP server card is published at [turva.dev/.well-known/mcp/server-card.json](https://turva.dev/.well-known/mcp/server-card.json).

## Protocol and implementation

A single Cloudflare Worker built on the Cloudflare Agents SDK serves the endpoint through `createMcpHandler` from `agents/mcp/server`, and it creates a fresh `McpServer` from `@modelcontextprotocol/server` for each request. There is no Durable Object or persistent MCP session.

The current protocol lane uses revision `2026-07-28`. A legacy lane at the same endpoint serves 2025-era clients. That lane is an adapter in the Agents SDK, and it answers through the web-standard server transport of `@modelcontextprotocol/server`. On the current lane every request must carry `MCP-Protocol-Version` and `Mcp-Method`, plus `Mcp-Name` for `tools/call`, and a request without one of them receives `400` with error `-32020`. `@modelcontextprotocol/server` checks `Mcp-Method` and `Mcp-Name`, and the Worker checks `MCP-Protocol-Version` before the handler runs, because that package reads the version from the request body and would otherwise answer a request that lacks the header. On the current lane nothing checks `Accept`, while the legacy lane answers `406` unless `Accept` lists both `application/json` and `text/event-stream`. Standard MCP clients handle these details.

`server/discover` is supplied by `@modelcontextprotocol/server`. It declares the `tools` capability with `listChanged: false`, because the tool set changes only on deploy and the server sends no change notifications, and it returns short instructions that say which tool answers which question.

The discovery documents and tool data are compiled into the Worker. This Worker is separate from the main turva.dev Worker, so changes here do not change the website.

## Dependencies

The code imports `@modelcontextprotocol/server`, `agents` and `zod`. `package.json` also lists `@modelcontextprotocol/client` and `@modelcontextprotocol/sdk`, which the code does not import. `agents` 0.23.0 declares all three MCP packages as required peer dependencies at exact versions, so npm has to install them, but neither of the two is in the built Worker.

## Security and operating limits

This server has no write path and returns only public data, so what it has to withstand is abuse of the endpoint itself: load from one address, requests built to be expensive, and a page on another site that calls it from a visitor's browser. The list below says how the endpoint meets them.

- Public and unauthenticated by design. Every exposed value is already public.
- Read-only MCP annotations on every tool. No destructive or open-world operation is declared, and no tool takes arguments.
- Rate limit: about 100 requests per 60 seconds per client IP, with `429` and `Retry-After: 60` after it. Cloudflare's rate-limiting binding keeps a separate, approximate count in each location, so a burst can pass more requests before the first `429`. The endpoint fails open if the rate-limiter binding is missing or errors.
- Request size: a body over 64 KiB receives `413` before the handler reads it, and a JSON-RPC batch receives `400` on both lanes, so one request cannot carry many tool calls past the rate limit.
- Browser CORS on `/mcp` allows only `https://turva.dev` as `Origin`. Other origins receive `403`. The check compares the hostname, so the scheme and the port are not part of it. Non-browser MCP clients normally send no `Origin` header and can connect directly. Discovery documents use open CORS so directories can read them.
- The code does not store request bodies, client identities or tool inputs. Cloudflare Workers observability is disabled. A rate-limiter failure writes a diagnostic error without request data.
- Security headers are applied to MCP and discovery responses.

For private vulnerability reports, see [SECURITY.md](SECURITY.md) or email [info@turva.dev](mailto:info@turva.dev).

## Related tools outside this server

The two checks below are separate tools. They are not MCP tools, and this server does not run them. For checks against another website, use the standalone npm packages:

- [turva-llms-txt-validator](https://www.npmjs.com/package/turva-llms-txt-validator) checks llms.txt structure and home-page discovery declarations. Its [browser version](https://turva.dev/llms-txt-validator) accepts any public domain.
- [markdown-parity-check](https://www.npmjs.com/package/markdown-parity-check) compares the main content of HTML and Markdown pages. Its [browser version](https://turva.dev/markdown-parity-check) checks turva.dev's own published pages only.

Both run with `npx`. The validator needs Node.js 18.17 or newer, and the comparison needs Node.js 22 or newer. Their [validator instructions](https://github.com/erekola/llms-txt-validator#quick-start) and [comparison instructions](https://github.com/erekola/markdown-parity-check#readme) explain the arguments and exit codes.

## Deploy your own copy

This repository is MIT licensed and can be adapted for another site. Before deploying a fork:

1. Replace the static service and evidence objects in `src/index.ts` with your own published data.
2. Replace the hard-coded `turva.dev` domain, MCP endpoint, browser origin and verification links with values you control.
3. Give the Worker a unique `name` and a rate-limit `namespace_id` that is not shared with another Worker in your Cloudflare account.
4. Attach your own custom domain. `workers_dev` is disabled in `wrangler.jsonc`.

Use Node.js 22 or 24, matching the repository's CI. From the root of your clone, install dependencies, run the tests and check the types before deploying with your Cloudflare account:

```sh
npm ci
npm test
npm run typecheck
npm run deploy
```

Configure the custom domain under Workers & Pages, your Worker, Settings, Domains & Routes. Use your own hostname and update the discovery endpoint in `src/index.ts` to match it.

## Maintainer

Built by [Erik Rekola](https://github.com/erekola) at [turva.dev](https://turva.dev). Questions about the implementation can go to [info@turva.dev](mailto:info@turva.dev). I work in writing. turva.dev builds servers like this one for other sites as a service, [MCP server design](https://turva.dev/services#mcp-server-design).

The business registration is available in the [Finnish Business Information System](https://tietopalvelu.ytj.fi/yritys/3600281-7).

## License

[MIT](LICENSE).
