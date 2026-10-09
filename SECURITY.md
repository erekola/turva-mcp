# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Open advisories

None as of 2026-10-09, the date of the last `npm audit` run against this
repository, which reported no vulnerabilities in the full tree and none with
`--omit=dev`. CI runs `npm audit --omit=dev --audit-level=moderate` on every
push and pull request, so a moderate or higher advisory in a runtime
dependency fails the build.

Before the changes below, three advisories were open on 2026-10-06, two of
them in the runtime tree. GHSA-6qxp-vccf-f47h, rated high, concerns the OAuth
client in `@modelcontextprotocol/sdk` before 1.31.0 and
`@modelcontextprotocol/client` before 2.2.0, which could send credentials to
an authorization server chosen by the MCP server. GHSA-jqcg-44mw-7w3h, rated
critical, is IP spoofing through an IPv4-mapped IPv6 trust subnet in
`proxy-addr` before 2.0.8, which the SDK reaches through `express`. The third,
GHSA-wq5f-xc86-pv6w, rated high, is in the librsvg that `sharp` 0.35.4 bundles.
It sat in the development tree, because `miniflare`, which wrangler 4.148.0
pulled in, pinned `sharp` at exactly 0.35.4.

`agents` 0.24.0 declares the SDK at exactly 1.30.0 and the client at exactly
2.0.0 as required peer dependencies, and so does 0.26.0, the newest `agents`
on that day. The fix `npm audit` offered was a downgrade to `agents` 0.20.0,
and it was not taken. `package.json` instead pins the SDK at 1.32.1 and the
client at 2.3.1, and two `overrides` entries, `"$@modelcontextprotocol/sdk"`
and `"$@modelcontextprotocol/client"`, point at those direct dependencies,
which replaces the exact peer pins. `@modelcontextprotocol/server` stays at
2.0.0, since GHSA-6qxp-vccf-f47h does not list it. `npm audit fix` moved
`proxy-addr` to 2.0.8 inside the range `express` declares. A third new
`overrides` entry forced `sharp` to `^0.35.5`, and `allowScripts` kept a key
for both 0.35.4, the version miniflare declared, and 0.35.5, the version
installed. Each override comes out when the package that pins the old version
moves past it. The `sharp` override came out on 2026-10-09, together with the
`allowScripts` key for 0.35.4: wrangler 4.149.0 pulls in `miniflare`
5.20261006.1-alpha, which pins `sharp` at exactly 0.35.5.

None of the three reached production. The source map of a build of this
repository lists files from `@modelcontextprotocol/server` and its two core
packages, `agents`, `zod`, `@cfworker/json-schema` and `content-type`. It
lists none from the SDK, the client, `express`, `proxy-addr` or the Node
adapter `@hono/node-server`, and the built `index.js` was byte-identical
before and after the change. The Worker contains no MCP client, so the OAuth
flow of the first advisory has nothing to run in.

An earlier run on 2026-10-01 cleared moderate advisories in two packages in
the dependency tree of the SDK. `hono` 4.13.5 had GHSA-hxh3-vqpv-xpqv, where
`hono/jsx` renders plain strings unescaped in boundary components.
`ip-address` 10.7.0, which `express-rate-limit` 8.7.0 pulls in, had
GHSA-j6r3-76f7-8jcv and GHSA-h3mg-xc3c-68pw. `npm audit fix` moved those two
transitive packages to `hono` 4.13.12 and `ip-address` 10.7.2, inside the
ranges their parents declare.

Before those, one advisory was a path traversal in the
`serve-static` part of `@hono/node-server`, and it arrived transitively:
`@modelcontextprotocol/sdk` depends on that Node HTTP adapter, and the SDK
version this repository pins, 1.32.1, declares `^1.19.9 || ^2.0.5`, so the
fixed 2.0.5 line is inside its range while the vulnerable 1.x line is still
permitted by it. Within that SDK two modules import the adapter, the
Node-side Streamable HTTP server transport and a Hono example, and this
Worker loads neither. It runs on workerd through the Cloudflare Agents SDK:
`agents/mcp/server` serves the endpoint with the web-standard server
transport of `@modelcontextprotocol/server` 2.0.0, and the source map of a
build of this repository contains neither `@modelcontextprotocol/sdk` nor
the adapter. The advisory never reached production.

It is cleared anyway, because this repository is public reference material
people read and fork. `package.json` carries an `overrides` entry forcing
`@hono/node-server` to `^2.0.5`, which resolves to a patched version and
takes `npm audit` to zero. The override is there for the lockfile alone, and
it stays until the SDK REQUIRES the 2.x adapter: as long as the SDK's own
range still permits 1.x, removing the override lets a known-vulnerable
version back into the lockfile of a public repository people fork.

*Corrected 2026-08-16 (round 12, batch E16, finding B3-5). The first paragraph
placed the fixed 2.0.5 release beyond the range the SDK declares. That was true
of SDK 1.29.0 and is not true of 1.30.0 or of 1.32.1, the release pinned since
2026-10-06. The
closing sentence also read as if the override were already due to come out.*

*Corrected 2026-09-23 (round 20, findings B-1 and TJ-1). The paragraph
miscounted the SDK modules that import the adapter, and it named the wrong
transport for the entry point of the Agents SDK. Its conclusion, that the
adapter never reached the deployed bundle, was right, and the reasons given
for it were not.*

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately
by emailing **info@turva.dev**.

Send encrypted reports to erik@turva.dev. The OpenPGP key is at https://turva.dev/pgp-key.asc.

Please do not open a public issue for security reports.

You can expect an initial response within one business day, in writing, by
email. If the issue is
confirmed, a fix will be prioritized and you'll be kept informed of progress.
