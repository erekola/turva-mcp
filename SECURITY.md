# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Open advisories

None as of 2026-09-02, the date of the last `npm audit` run against this
repository. The one that had been open was a path traversal in the
`serve-static` part of `@hono/node-server`, and it arrived transitively:
`@modelcontextprotocol/sdk` depends on that Node HTTP adapter, and the SDK
version this repository pins, 1.30.0, declares `^1.19.9 || ^2.0.5`, so the
fixed 2.0.5 line is inside its range while the vulnerable 1.x line is still
permitted by it. The adapter is
imported by exactly one SDK module, the Node-side Streamable HTTP server
transport, and this Worker never loads it. It runs on workerd through the
Cloudflare Agents SDK, whose MCP entry point uses the client transport, so
the adapter was never in the deployed bundle and the advisory never reached
production.

It is cleared anyway, because this repository is public reference material
people read and fork. `package.json` carries an `overrides` entry forcing
`@hono/node-server` to `^2.0.5`, which resolves to a patched version and
takes `npm audit` to zero. The override is there for the lockfile alone, and
it stays until the SDK REQUIRES the 2.x adapter: as long as the SDK's own
range still permits 1.x, removing the override lets a known-vulnerable
version back into the lockfile of a public repository people fork.

*Corrected 2026-08-16 (round 12, batch E16, finding B3-5). The first paragraph
placed the fixed 2.0.5 release beyond the range the SDK declares. That was true
of SDK 1.29.0 and is not true of the 1.30.0 this repository pins today. The
closing sentence also read as if the override were already due to come out.*

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately
by emailing **info@turva.dev**.

Please do not open a public issue for security reports.

You can expect an initial response within a few days. If the issue is
confirmed, a fix will be prioritized and you'll be kept informed of progress.
