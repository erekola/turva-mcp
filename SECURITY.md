# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Open advisories

None as of 2026-07-26. The one that had been open was a path traversal in the
`serve-static` part of `@hono/node-server`, and it arrived transitively:
`@modelcontextprotocol/sdk` depends on that Node HTTP adapter and pins
`^1.19.9`, while the fix landed in 2.0.5, outside the pin. The adapter is
imported by exactly one SDK module, the Node-side Streamable HTTP server
transport, and this Worker never loads it. It runs on workerd through the
Cloudflare Agents SDK, whose MCP entry point uses the client transport, so
the adapter was never in the deployed bundle and the advisory never reached
production.

It is cleared anyway, because this repository is public reference material
people read and fork. `package.json` carries an `overrides` entry forcing
`@hono/node-server` to `^2.0.5`, which resolves to a patched version and
takes `npm audit` to zero. The override is there for the lockfile alone and
comes out once the SDK moves to the 2.x adapter itself.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately
by emailing **info@turva.dev**.

Please do not open a public issue for security reports.

You can expect an initial response within a few days. If the issue is
confirmed, a fix will be prioritized and you'll be kept informed of progress.
