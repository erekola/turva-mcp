import { McpServer, PROTOCOL_VERSION_META_KEY, isJsonContentType, SUBSCRIPTION_ID_META_KEY, SERVER_INFO_META_KEY, specTypeSchemas, validateOriginHeader, classifyInboundRequest, UnsupportedProtocolVersionError } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
// The namespace import lets the bundler keep only the parts of zod the schemas below use.
// Importing the named z export instead pulled in all of zod: a dry-run build measured
// 1234.85 KiB against 688.39 KiB this way, and 679.49 KiB before the schemas existed.
import * as z from "zod";

// "The SDK" in the comments of this file is @modelcontextprotocol/server, the server package
// of the MCP TypeScript SDK. The older @modelcontextprotocol/sdk package is installed only as
// a peer dependency of agents, and this Worker does not import it.

// These data objects are exported for the tests in turva-mcp/test. The worker runtime uses
// the default export alone, so this adds a test surface and no behaviour.
export const SERVICES = {
  pricing_model: "fixed_list_prices",
  // Corrected 2026-09-28 (S00-00 D11, 3rd round): named the same three-way VAT treatment
  // /services already states, instead of leaving "VAT not included" unspecified here.
  // Corrected 2026-09-28 (P4, 3rd round): named when an implementation add-on is bought.
  // Corrected 2026-10-22 (outside review, A2): reverse charge is named for business customers in another
  // EU member state, and outside the EU no Finnish VAT applies because the place of supply is outside Finland.
  pricing_note: "The audit, advisory and implementation have fixed list prices in EUR, VAT not included: 25,5% for Finnish customers, reverse charge for business customers in another EU member state with a valid VAT ID, no Finnish VAT for customers outside the EU, because the place of supply is outside Finland. The MCP server security test, agent operations and MCP server design are scoped and quoted per engagement. One implementation add-on carries a fixed price and is sold only with the audit it follows, listed under bundled_implementation. The add-on can be bought together with the audit, with its report, or after the report and before implementation starts. Active security testing is an add-on to the audit, priced by quote for each written scope, listed under quoted_add_ons. Request a quote: turva.dev",
  currency: "EUR",
  vat_included: false,
  engagement: {
    communication: "async_only",
    notes: [
      "All communication is async. No calls and no calendar links.",
      "Read access is enough for the audit. Write access to repositories is scoped per task.",
      "Existing production passwords are not requested. Correction add-ons and implementation need delegated access agreed in writing in advance: deployment access or DNS access when a fix requires it.",
      // Corrected 2026-09-28 (P2, 3rd round): the written scope, not an unstated cap,
      // bounds how many fixes, questions or review pages a service month covers.
      "The written scope agreed before kickoff sets how many fixes, questions or review pages the work covers, and work beyond it is quoted separately at the day rate.",
      // Corrected 2026-09-28 (P4, 3rd round): named how a written-scope date moves and
      // when access counts as arranged, and that a failed re-check is redone free.
      "Dates in the written scope move by the business days spent waiting for your approval or access, and access counts as arranged when the account named in writing for that access works.",
      "A fix that fails its re-check is redone at no charge in the follow-up round of that re-check.",
      // Corrected 2026-09-28 (P6, 3rd round): completion is measured against the written
      // plan, not an outside scanner.
      // Corrected 2026-11-06 (agent experiment 3, V3): the payment sentence holds for every engagement
      // and the completion sentence for MCP server design, as /legal and /services state.
      "Payment does not depend on an outside scanner's result.",
      "For MCP server design, the work is done when the checks named in the written plan pass.",
    ],
  },
  // Every deliverable here is a promise the site makes in prose, and the two are written
  // by hand in two repos. Astra measured the drift 2026-09-10: the audit deliverable did
  // not carry the re-scan within 30 days of the report that /services, /agent-readiness-
  // audit and the JSON-LD promise in seven places, the advisory deliverable dropped the
  // monthly written summary, and the retest of the since-retired Shopify check gave 14 days without the day it
  // counts from. verify.mts --live now reads these strings for the dated promises, so a
  // deliverable that loses one fails the gate rather than the reader.
  //
  // url is the turva.dev page that describes the service, and sample_url a published
  // sample of its deliverable where one exists. The /services anchors are the service ids.
  services: [
    {
      id: "audit",
      name: "Agent-Readiness Audit",
      url: "https://turva.dev/agent-readiness-audit",
      sample_url: "https://turva.dev/samples/audit-report",
      price: 4300,
      unit: "fixed",
      duration: "2 weeks",
      duration_from: "agreed written kickoff",
      // Added 2026-11-22 (outside read P1): the two-target limit of the audit page, in its words, beside the price.
      summary: "Fixed scope. An independent public scanner runs against the site or API, followed by a written report with a prioritized fix list. The audit covers up to two targets named in the written scope, at one fixed price.",
      deliverable: "A measured baseline, a clear plan for what to fix first, and a fix instruction for every finding with a link to the matching guide on turva.dev where a guide covers that surface. You also receive the recorded AI questions and answers, one round of written follow-up questions submitted within 14 calendar days of the report and answered within five business days, and one re-scan within 30 days of the report, or within 30 days of the delivered corrections when the correction add-on is bought. The written scope agreed before kickoff sets how many questions that round covers.",
    },
    {
      id: "advisory",
      name: "Advisory",
      url: "https://turva.dev/services#advisory",
      price: 3000,
      unit: "month",
      minimum_commitment: "3 months",
      summary: "Monthly retainer, async-only. Ongoing review as the site, API, or product evolves.",
      // Corrected 2026-09-28 (Tek-528, S3 P1/A1/A2/A4/A6): the deliverable named the
      // monthly and quarterly measurements but not the renewal and cancellation terms
      // /services states, the per-check evidence attached to the summary, the review
      // cap that bounds the retainer, or the retainer's own exclusions.
      deliverable: "A monthly re-scan with the same scanner and profile, shown beside the previous result, a monthly repeat of the AI question set, written review of the agent-readiness changes your team ships within one business day up to four reviews per service month, recommendations for the roadmap, questions and answers by email or a shared document and a monthly written summary that reads the month's measurements next to the previous month's with the dated per-check results and recorded AI questions and answers attached. Up to four written change reviews per service month are included, each covering one named deployment, and unused reviews expire at month end. A quarterly summary of measured changes, including unchanged or worse results, is delivered within five business days after every third service month, counted from the agreed written kickoff anniversary. The monthly summary is delivered within five business days after the month ends. Each review explains what changed and what the evidence supports. The retainer excludes implementation, continuous monitoring, incident response and operating your production systems. If you are not satisfied with the first month, you can end the retainer by email sent at any time during the first month, up to the day before the second month starts. The retainer then ends when the first month ends, and the second and third months are not charged. Notice given in the second or third month ends the retainer at the end of the three-month minimum, and the months up to that end are charged. After the three-month minimum the retainer runs month to month, and either party can end it by email before the next month starts. A higher score or an AI mention is not guaranteed.",
    },
    {
      id: "implementation",
      name: "Implementation",
      url: "https://turva.dev/services#implementation",
      price: 1500,
      unit: "day",
      summary: "Booked per day. Worker-level changes, well-known manifests, discovery cards for an MCP server that already runs, JSON-LD and Schema fixes. Building the MCP server itself is scoped separately.",
      // Corrected 2026-09-28 (Tek-528, S3 P/I2/I3/I4/I5/I8/I9): the deliverable named
      // only the follow-up scan, not the completion date, the handover package, the
      // day rate's definition, its exclusions, the per-correction acceptance check or
      // the handover question round /services states.
      deliverable: "The completion date is agreed as a stated number of business days from the agreed written kickoff before the work starts. Delivery includes test results, deployment instructions, rollback instructions and a list of any unresolved external dependencies. The improvement is verifiable against the audit baseline in the next scan, or a direct test. Every implemented correction gets its own acceptance check, source changes are verified separately from edge changes and a failed or unverified item is left open. One round of handover questions submitted within 14 calendar days of delivery is answered within five business days. A billable day is seven and a half hours of work, covering implementation, testing and handover. Recurring hosting, ongoing monitoring and maintenance after handover are not included in the implementation fee.",
    },
    {
      id: "mcp-server-security-test",
      name: "MCP Server Security Test",
      url: "https://turva.dev/services#mcp-server-security-test",
      price: "on request",
      // Added 2026-11-21 with the service's section on /services. The wording follows that section.
      summary: "On request. One MCP server, tested from the outside with two test accounts that the client provides. A scripted walkthrough takes every tool the client's tool table allows through the same list of 18 checks, and two test runs with GLM 5.3 follow it. The test can be bought without an audit and starts only after a signed written authorization and a check that the client controls the target.",
      deliverable: "A report of findings, each with its severity, a CVSS vector, the affected target, a command that reproduces it, redacted evidence and a recommended fix. With it come an executive summary of one page, a coverage matrix of tools and checks, a table of observations on a selection of the requirements of a named and dated version of the MCP specification, and a framework map against the OWASP MCP Top 10 in its beta version, the OWASP API Security Top 10 2023 and the OWASP Top 10 for LLM Applications 2025. The client also receives a list of questions for its own team, a timeline of the test traffic, one retest of the reported findings within 30 days of the report and one round of written questions within 14 days of the report. The standard scope covers one MCP server at one endpoint address, at most 25 tools, at most 25 resources, resource templates and prompts in total, two test accounts and one environment. It excludes denial of service, load and stress testing, social engineering, review of source code and other MCP servers. A test does not certify that a server is safe, and it is not a compliance assessment.",
    },
    {
      id: "agent-operations",
      name: "Agent Operations",
      url: "https://turva.dev/services#agent-operations",
      price: "on request",
      summary: "On request. The work beyond readiness: the data path an agent acts on, and the decision envelope of permissions and thresholds that bounds what it may decide.",
      // Corrected 2026-09-28 (V08-U2): "does exactly what it claims" promised an
      // unconditional result. /services.md itself disclaims that: this service covers
      // the controls around an agent, not building the agent or certifying it is safe.
      // Corrected 2026-09-28 (Tek-528, S3 P/O1/O2/O4/O6/O7/O12): the deliverable named
      // only the outcome, not the review package's own milestones, scope limits,
      // exclusions or how delivery is checked, which /services states.
      deliverable: "Within five business days of the agreed written kickoff, a draft map of the workflow, data sources, connected systems and points where information can be lost, delayed or misread. Within ten business days, a written control specification listing allowed actions, permission boundaries, human-decision thresholds and handover rules, together with the results of ten agreed test scenarios: the input, expected control behavior, observed result and any part that could not be tested. The review package covers one existing agent, one named workflow, up to three connected systems and up to ten action types, and excludes production changes, penetration testing, continuous monitoring and incident response unless the written engagement explicitly adds them. Delivery is checked against the agreed workflow, action list, documents and the ten scenarios, without treating a successful test as a safety certification. This covers the controls around an agent, not building the agent itself or certifying that it is safe.",
    },
    {
      id: "mcp-server-design",
      name: "MCP Server Design",
      url: "https://turva.dev/services#mcp-server-design",
      price: "on request",
      summary: "On request. Read-only discovery tools over Streamable HTTP. For public, non-sensitive data, no auth surface and no logging by default; auth and an audit trail follow the data and the misuse model.",
      // Corrected 2026-09-28 (V08-U2): "without becoming an abuse vector" promised an
      // unconditional result; /services.md names what still needs considering per tool.
      // Corrected 2026-09-28 (Tek-528, S3 P3/M1/M2/M4/M5/M7/M8): the deliverable named
      // only the outcome, not the design and build milestones, the starter scope
      // limits, its exclusions, or what the registry step actually does. Registry
      // work is a submission with a recorded status, not a promise of acceptance.
      // Corrected 2026-10-03 (W45, Tek-564): the sentence "An endpoint that stays readable for
      // agents." was an orphan; it now says what /services serves, that read-only tools cannot
      // modify the source through that interface.
      deliverable: "Within five business days of the agreed written kickoff, a written design covering tool names, input and output schemas, data fields, examples, errors and access rules. Within fifteen business days, the working server in the agreed hosting environment, its source code, deployment configuration and server card, plus submission to one agreed MCP registry with the listing's status recorded as accepted, pending or rejected. The starter scope covers one server, up to three read-only tools, one existing API, one hosting environment and compatibility checks with two named MCP clients, and excludes building or repairing the source API, correcting source data, recurring hosting charges and maintenance after handover. Read-only tools cannot modify the source through that interface. Data exposure, bulk extraction and availability still need to be considered for each tool. Registry acceptance and use of the server by an external assistant are not promised.",
    },
  ],
  bundled_implementation: [
    {
      id: "audit-fixes",
      name: "Audit fix implementation",
      price: 499,
      unit: "fixed",
      requires: "audit",
      sold_separately: false,
      // Corrected 2026-09-28 (V08-28/P14): named the access /services.md already names
      // for this add-on, instead of leaving "arranged in advance" unspecified here.
      summary: "Implementation of exactly the fixes the audit report lists. Sold only with the audit, bought together with it, with its report, or after the report and before implementation starts, and only when the required access is arranged in advance: an edge runtime in front of your origin, deployment access and any other access the listed fixes require, such as DNS. Work outside that list is scoped at the implementation day rate.",
      // V5: the same consequence the server card and /services state when the access is missing.
      if_access_missing: "The add-on is not sold and the report still carries the correction instructions.",
    },
  ],
  // Added 2026-11-08 (Tek-784). A quoted add-on is priced by quote, so its price is the string on request and
  // never a number, and like the bundled add-on it cannot be bought without the audit. It is a separate list
  // because bundled_implementation holds fixed prices; the wording is the /services wording for active security testing.
  quoted_add_ons: [
    {
      id: "active-security-testing",
      name: "Active security testing",
      url: "https://turva.dev/services#active-security-testing",
      price: "on request",
      requires: "audit",
      sold_separately: false,
      summary: "An add-on to the audit, priced by quote for each written scope. Tests the agent surfaces the audit reads, or your own AI agent or web application where the written scope says so, with GLM 5.3 and Burp Suite Professional for web traffic, and starts only after you sign a written authorization.",
    },
  ],
  // Added 2026-11-21 (Tek-886, Glama TDQS completeness): the contract terms and the sample report were only linked, so a
  // question about a clause or about what a report holds ended in a dead end. contract_terms mirrors every paragraph of the
  // ### subsections under ## Engagement terms of the /legal twin in worker.ts, byte for byte, and sample_report names the
  // sections and the example findings of the /samples/audit-report twin. tools/verify.mjs reads both pages and fails the run
  // when a string here no longer occurs in them or a subsection has no key, so a change to either page fails the gate.
  contract_terms: {
    url: "https://turva.dev/legal",
    applies_to: [
      "These terms apply to audits, advisory, implementation, the MCP server security test, agent operations and MCP server design, including the active security testing add-on, unless a written agreement replaces them. The services are sold only to businesses and other organizations acting in their trade or profession, not to consumers.",
    ],
    scope: [
      "We agree the scope in writing before work starts. Your email reply that confirms the written scope is the order. Changes need a new written agreement and may affect the price and schedule.",
    ],
    business_days: [
      "A business day means Finland's business days, Monday to Friday, excluding Finnish public holidays, in Europe/Helsinki time.",
    ],
    deliverables: [
      "An audit produces a written report. An MCP server security test produces a written report. Its section on the services page lists the parts of the report and the other deliverables. Advisory includes written reviews and a monthly summary. Implementation is delivered as the agreed changes. Code the work produces is committed to the agreed repository. A settings change, for example in a CMS, a DNS zone or a media library, is delivered as a record of what was changed and the check that confirms it. A fix that fails its re-check is redone at no charge in the follow-up round of that re-check.",
    ],
    payment: [
      "Payment is due within fourteen days of the invoice date unless agreed otherwise in writing. Late-payment interest follows Finnish law. Payment does not depend on an outside scanner's result.",
    ],
    cancellation_and_refunds: [
      "An engagement canceled before its agreed written kickoff is not charged, and anything already paid for it is refunded in full. Cancellation after its agreed written kickoff is charged for the work already delivered: the agreed share of delivered parts for a fixed-price service, the hours worked for work billed by the day and, for advisory, the months the next paragraph sets out.",
      "For advisory, if you are not satisfied with the first month, you can end the retainer by email sent at any time during the first month, up to the day before the second month starts. The retainer then ends when the first month ends, and the second and third months are not charged. Notice given in the second or third month ends the retainer at the end of the three-month minimum, and the months up to that end are charged. After the minimum, notice ends it at the end of the current month.",
      "Cancellation of a fixed-price service or the correction add-on is charged by the share of listed parts or fixes delivered. Cancellation of the active security testing add-on or of an MCP server security test is charged by the share of its agreed written scope delivered. A remedy under Delay or Continuity takes precedence over this share. Work billed by the day is charged by the hours worked, in half-hour steps, and for MCP server design and agent operations the written scope states the share of each phase.",
      "A refund is paid within fourteen days of the cancellation or of the missed deadline that triggers it.",
      "A deliverable that does not match its service page is corrected at no charge. Report the deviation in writing within 14 calendar days of delivery, and the correction is made within 10 business days of the report. You can report a deviation in an earlier deliverable within 14 calendar days of delivery of the written result of the included re-scan or retest in which it first shows. If the correction does not succeed, the share of the listed parts that still does not match is treated as not delivered, and you may cancel that share under the rules above.",
    ],
    delay: [
      "Dates in the written scope move by the business days spent waiting for your approval or access, and access counts as arranged when the account named in writing for that access works. If a date in the written scope slips because of turva.dev, you can cancel the part not yet delivered. That part is not charged, and anything already paid for it is refunded in full. A late advisory review is still delivered in full, and the delay is stated with it.",
    ],
    continuity: [
      "turva.dev is run by one person. If Erik Rekola falls ill or is otherwise unable to work, delivery moves. You can then cancel the part not yet delivered, and anything already paid for that part is refunded in full.",
    ],
    confidentiality: [
      "Information shared during the work is confidential. Your own non-disclosure agreement is signed as it stands, at no charge, before material is shared.",
      "If the work gives turva.dev access to personal data you control, turva.dev acts as your processor, and your data processing agreement is signed before that data is shared. As your processor, turva.dev notifies you without undue delay after becoming aware of a personal data breach affecting that data, as Article 33(2) of the GDPR requires. Sub-processor changes follow the terms of that agreement.",
      "The audit does not require production credentials. Access for purchased implementation is agreed separately and limited to the work. Test accounts for active security testing and the MCP server security test are provided by the client and named in the signed authorization.",
    ],
    liability: [
      "Liability is limited to the fee for the engagement excluding VAT, including any add-on bought with it, as one aggregate limit for the whole engagement. For monthly advisory, that fee is the fees paid in the twelve months before the claim, excluding VAT. turva.dev is not liable for indirect or consequential damages. Neither limit applies when turva.dev causes damage intentionally or through gross negligence. Where a signed non-disclosure agreement sets its own remedies for a breach of confidentiality, those remedies apply to that breach. For data protection claims, the liability clause of a signed data processing agreement prevails where it differs from this paragraph.",
    ],
    intellectual_property: [
      "You own the deliverables produced for you. turva.dev retains its generic methods, templates and reusable code. You get a perpetual right to use the delivered code, including any of turva.dev's own parts built into it.",
    ],
    governing_law: [
      "Finnish law applies. Disputes are resolved in the District Court of Pirkanmaa, Finland.",
    ],
    // Added 2026-11-22 (outside read P6): the ## Updates section of the /legal twin, byte for byte, which says the terms apply
    // to engagements started on or after the Terms date. The page's list is one block, so it is one string with its line break.
    updates: [
      "This page is updated when the terms or the privacy sections change. The terms apply to engagements started on or after the Terms date below, and the privacy sections apply from the Privacy date below.",
      "- **Terms last updated:** 2026-11-21\n- **Privacy last updated:** 2026-11-21",
    ],
  },
  sample_report: {
    url: "https://turva.dev/samples/audit-report",
    title: "A sample website and API audit",
    fictional: true,
    sections: [
      "What to fix first",
      "The main findings",
      "Contents",
      "The agreed work",
      "Decisions for the company",
      "Fixes, owners and estimated effort",
      "What each party delivers",
      "What was checked",
      "Technical scan results",
      "Findings from the manual review",
      "What the assistants answered",
      "Public security checks",
      "The findings in detail",
      "After the report",
      "Scope limits",
      "Appendix A. From evidence to a checked fix",
      "Appendix B. Questions and test conditions",
      "About this sample",
    ],
    example_findings: [
      "F1. Product prices and availability disagree across the page, structured data and API",
      "F2. Offer Markdown alongside HTML",
      "F3. Publish llms.txt and link to it in response headers",
      "F4. Add the product catalog to the sitemap",
      "F5. State the company's AI crawler preferences in robots.txt",
      "F6. Make the existing REST API discoverable",
      "F7. Enable DNSSEC now and hold the DNS discovery record",
      "F8. Keep agent checkout undeclared until it is supported",
      "F9. Correct the published address",
    ],
  },
} as const;

export const AGENT_READINESS = {
  domain: "turva.dev",
  measured_at: "2026-11-15",
  // Corrected 2026-09-28 (32/T1-01): "Always verify against the live links below" was an
  // imperative addressed to the caller; this states the fact instead.
  // Corrected 2026-09-28 (V08-N01, 3rd round): "the live links below carry the current
  // reading" implied that following the url shows the recorded score; it opens the
  // scanner's start page instead, matching what the homepage says about the same link.
  note: "Scores are a point-in-time reading by an independent public scanner, not a permanent state; the scan url opens the scanner's start page, where a new check can be run, and does not show the recorded reading itself.",
  scans: [
    {
      provider: "isitagentready.com",
      result: "100/100, Level 5 (Agent-Native)",
      note: "isitagentready.com is Cloudflare's agent-readiness scanner. The reading is the scanner's, not turva.dev's, and it can be re-run by anyone.",
      categories: {
        discoverability: "100/100",
        content: "100/100",
        bot_access_control: "100/100",
        api_auth_mcp_a2a_discovery: "100/100",
        commerce: "100/100",
      },
      url: "https://isitagentready.com/",
    },
  ],
} as const;

export const SECURITY_EVIDENCE = {
  domain: "turva.dev",
  measured_at: "2026-11-15",
  scans: [
    {
      provider: "Hardenize",
      result: "24/24 categories passed",
      measured_at: "2026-11-15",
      url: "https://www.hardenize.com/report/turva.dev",
    },
    {
      provider: "Internet.nl",
      score: 98,
      scale: "0-100",
      note: "IPv6, DNSSEC and RPKI pass in full. The single deduction is one HTTPS sub-test, the hash function for key exchange.",
      // V4: the tool description promises each scan its date; both Internet.nl tests were read on the top-level date.
      measured_at: "2026-11-15",
      url: "https://internet.nl/site/turva.dev/",
    },
    {
      provider: "Internet.nl (email)",
      score: 90,
      scale: "0-100",
      note: "DNSSEC, DMARC with DKIM and SPF, STARTTLS with DANE, and RPKI pass in full. The deduction is IPv6: the receiving mail servers, which the mail provider operates, publish no IPv6 address.",
      measured_at: "2026-11-15",
      url: "https://internet.nl/mail/turva.dev/",
    },
  ],
  note: "We publish our own domain's scan results as proof that we follow the same practices we recommend to clients.",
} as const;

// measured-result says what the site says of the audit: the promise covers the fixes the
// audit report names.
// A promise of a higher reading without that bound would contradict the advisory
// deliverable above, which says in as many words that a higher score is not guaranteed.
export const PRINCIPLES = {
  model: "agent_readiness_audit",
  rules: [
    { id: "async-only", title: "All communication is async", rationale: "No calls and no calendar links. Everything stays in writing, so the work and the trail are auditable end to end." },
    { id: "least-access", title: "No production credentials, scoped write access", rationale: "Read access is enough for the audit. Write access to repositories is scoped per task." },
    // Corrected 2026-09-28 (V08-29): "the next scan either reads higher ... or the
    // report explains which tradeoff was kept on purpose" promised more than
    // /agent-readiness-audit.md does; this now matches that page's own wording
    // ("Technical fixes are checked with the relevant scanner or a direct test ... The
    // follow-up shows both readings and any changes in the method").
    { id: "measured-result", title: "Each fix is checked and recorded", rationale: "Once the fixes the audit report names are implemented, the follow-up checks each one with the relevant scanner or a direct test and records both readings and any change in the method, even when no score moves." },
    { id: "transparency", title: "Open and verifiable", rationale: "Backed by a registered business, Business ID 3600281-7, Finland. Our own domain's scores are publicly verifiable." },
  ],
} as const;

// The fifth tool's data. Every channel here is mirrored from
// turva-worker/tools/facts.json channels, which is the one home for them, and the
// engagement lines say the same as the /contact twin in worker.ts. The channels are a
// deliberate subset of that file: email, Signal and LinkedIn are ways to start an
// engagement, while its Mastodon, Gravatar and GitHub entries are profiles, and they are
// left out here for the same reason turva-worker/tools/verify.mts leaves them out of its
// comparison. The decision is Tek-372.
//
// A tool named get_contact ALSO exists on a different protocol: the in-page WebMCP
// script (WEBMCP_SCRIPT in worker.ts) offers one to a browser. Same name, different
// shape on purpose. That one carries the Signal handle beside the link and no
// engagement fields, this one carries the first reply time and what access an audit
// needs, and the two are not merged because the WebMCP script's bytes are pinned by a
// CSP script-src hash, so a field added there is a deploy-time hash change. The values
// they share come from the same facts.json entries, so they cannot drift apart in
// substance; if either one gains a CHANNEL, change facts.json first and mirror both.
//
// The operator object says who runs turva.dev in the words of the Business details section
// of the /company twin in worker.ts, and its business_id and vat_id are facts.json businessId
// and vatId, which the public verify compares live. It was added in 1.6.0 because Glama's
// tool-definition review found no company background or team information in the tool set,
// although the /company page states both.
export const CONTACT = {
  email: "info@turva.dev",
  signal: "https://signal.me/#eu/2qzayURnxbJ8wl7dmQOd5c3sAF7cW8xvDVUrNiG6Cl7rEsXfkSlIsYOS9FSjJixK",
  linkedin: "https://www.linkedin.com/in/erikrekola/",
  business_id: "3600281-7",
  location: "Tampere, Finland",
  engagement: "async_only",
  correspondence_languages: ["en", "fi"],
  first_reply: "Within one business day, in writing, by email or Signal. LinkedIn messages have no set reply time.",
  channel_note: "Email for longer messages, Signal for short questions. No calls and no calendar links.",
  how_to_start: [
    "Email the domain you want read and the question you want answered. That is enough to start.",
    "Read access is enough for the audit. Production credentials are not requested.",
    "Write access to repositories is scoped per task.",
  ],
  operator: {
    name: "turva.dev",
    run_by: "Erik Rekola",
    legal_form: "Sole proprietorship registered in Finland",
    business_id: "3600281-7",
    vat_id: "FI36002817",
    location: "Tampere, Pirkanmaa, Finland",
    // V2: the same postal address /company, /contact and /legal state.
    postal_address: "c/o turva.dev, P.O. Box 999, 42011 YRITYSLOKERO, Finland",
    team: "One person. Clients work directly with Erik Rekola, from agreeing the scope to reading the findings.",
    background: "Erik Rekola is an independent consultant in Tampere. Before turva.dev, Erik Rekola worked hands-on with industrial and laboratory equipment from 2015 to 2021: paper machinery at UPM, medical washer-disinfectors at Franke, a clinical LC-MS/MS analyzer at Thermo Fisher Scientific and semiconductor production equipment at ASM International.",
    company_page: "https://turva.dev/company",
    legal_page: "https://turva.dev/legal",
  },
  // Added 2026-11-21 (Tek-886): the privacy sections of the /legal twin in worker.ts, byte for byte except that a markdown
  // link [text](url) is reduced to text. The two sections AI tools in security work and Where the work runs are left out
  // on purpose and not_included says so. tools/verify.mjs fails the run when a string here no longer occurs in the page.
  privacy: {
    url: "https://turva.dev/legal",
    overview: [
      "The site does not use analytics cookies, tracking pixels or third-party scripts. Cookies are described under Cookies below.",
    ],
    roles: [
      "turva.dev is the controller of the personal data it collects for its own business: correspondence, invoicing and the outreach records described below. The lawful basis is the contract for engagement data and a legal obligation for accounting records.",
      "Outreach, the server logs that keep the site running and secure, the analysis of a traffic spike, the site's rate limit and processing a client's own contact persons rest on legitimate interest. So does operating the llms.txt validator, which means fetching and checking the documents the user names. Vulnerability reports and agent registration requests arrive by email and rest on legitimate interest as well, in keeping the site secure and in answering the sender. They are kept for 24 months from the latest message and removed sooner on request.",
      "For personal data that reaches a report from public sources, Article 14 applies: the report masks names and personal contact details found in public results and shows only the role.",
      "Contact and invoicing details are needed to agree and invoice an engagement, and without them the work cannot be agreed.",
      "When an engagement gives turva.dev access to personal data a client controls, turva.dev is the client's processor and handles that data only on the client's written instructions.",
    ],
    server_logs: [
      "Cloudflare, the hosting provider, records standard request logs, including IP address, user agent and requested path. The site's own Worker logs are kept for at most seven days, the longest retention Cloudflare offers for them.",
      "When turva.dev analyzes a traffic spike, it reads the addresses behind it from Cloudflare's analytics. On the Pro plan this site uses, Cloudflare's security analytics documentation gives up to 31 days of both security analytics and security events. The site's rate limits count requests per IP address inside Cloudflare, and turva.dev does not store those counts. The analysis it saves keeps the network operator and the request counts without the addresses.",
      "Analyses saved before 25 September 2026 also held addresses. Those addresses were removed on 25 September 2026. A private version-history copy of those earlier versions lasts as long as the backups: it is removed when the backup rotation described below replaces the corresponding backup, within 16 weeks at most.",
      "Cloudflare's own processing follows its privacy policy.",
      "The llms.txt validator fetches two documents from the site you name, with new requests that do not pass on the headers of your request. Cloudflare's HTTP headers documentation says that when that site is not hosted on Cloudflare, the Worker controls the CF-Connecting-IP and X-Real-IP headers, and the validator sets both to the fixed address 2a06:98c0:3600::103, which that documentation names for a Worker's requests to another Cloudflare zone. On 22 October 2026 turva.dev measured the two requests the validator made to one test site outside Cloudflare, one for /llms.txt and one for the home page, as the test site recorded them. Both carried the fixed address in CF-Connecting-IP. Neither carried X-Real-IP or X-Forwarded-For, although the validator sets X-Real-IP, and no header held the IP address of the person who ran the test. The connection came from a Cloudflare address.",
    ],
    international_transfers: [
      "Cloudflare, Inc. in the United States is certified under the EU-U.S. Data Privacy Framework, and its data processing addendum also includes the EU standard contractual clauses.",
      "For a customer in the EEA, Anthropic's commercial terms name Anthropic Ireland, Limited as the contracting party. Anthropic's data processing addendum for the Anthropic API incorporates the EU Standard Contractual Clauses, Module Two or Module Three, where data protection law requires them, with the Anthropic entity that signed the agreement as data importer. Anthropic says that data is stored in the US. Anthropic's data residency documentation adds that by default inference can run in any available geography.",
      "For a business in Finland, the Stripe contracting party is Stripe Payments Europe, Limited in Ireland, and Stripe relies on the EU-U.S. Data Privacy Framework for transfers to Stripe, LLC in the United States.",
      "Proton AG is in Switzerland, which the European Commission recognizes as providing adequate protection.",
      "Synology Inc. is in Taiwan, and the encrypted cloud backup is stored in its Frankfurt region in Germany. Synology's terms say that once a region is chosen it does not transfer the data unless the customer requests its C2 Express Box service, and its data processing agreement includes the EU standard contractual clauses for transfers to countries without adequate protection.",
      "Signal Messenger LLC in the United States carries a message only when the sender chooses Signal, and Signal's own terms say the data goes to the United States and other countries without naming a transfer mechanism. Email to info@turva.dev stays available for anyone who prefers to avoid that transfer.",
      "When a user of the llms.txt validator names a site outside the EEA, the validator builds its requests to send the fixed address in place of the visitor's IP address, and the measurement described in the Server logs section above found no visitor address in the two requests it covered.",
    ],
    email: [
      "Email related to an engagement, with its attachments, is deleted under the closing rule in the Client material section below. Only bookkeeping material is kept longer: accounting vouchers such as invoices and receipts, with their attachments, are kept for six years from the end of the year in which the financial year ended, the retention the Finnish Accounting Act sets for accounting material.",
      "A question sent by email, Signal or LinkedIn that does not lead to an engagement is deleted 24 months after the latest message. The Mastodon link in the site footer points to a public profile and is not an offered way to contact turva.dev.",
    ],
    client_material: [
      "Client material, including findings, evidence and test credentials, is stored only on systems needed for the work. It is deleted from them within thirty days of the engagement closing, which is the day the last deliverable, any retest included, is delivered, or, when no retest is requested or a requested retest lapses or is not carried out, 90 days after the last deliverable was delivered, unless the law requires retention. For example, when the last deliverable arrives on 1 March and no retest is requested, the engagement closes on 30 May. The material is then deleted from the working systems by 29 June, about 120 days after delivery, and has left every backup by 19 October.",
      "An engagement canceled before its agreed written kickoff, or after kickoff and before any delivery, closes 90 days after the cancellation. An engagement canceled after a partial delivery closes 90 days after the last deliverable was delivered, or on the day of the cancellation if that is later.",
      "Four kinds of copy follow their own rules. Bookkeeping material follows the six-year rule in the Email section above. The AI model providers keep what they processed under their own terms, linked under AI tools. Backups made during the engagement keep a copy until their rotation replaces them. The fourth kind, earlier versions of client files, is described below.",
      "The file backups on turva.dev's own network storage keep earlier versions of a file for up to 30 days and snapshots for up to 11 weeks, and the encrypted cloud backup of that storage keeps its versions for up to 11 weeks. Disk images of the workstation, which include the virtual machine's disk file, are kept for up to 14 weeks, plus up to 14 days in the snapshots of the storage that holds them. One encrypted disk kept off site holds only turva.dev's own keys and passwords, never client material, and is not part of this rotation. Every other backup, version history included, is removed within 16 weeks. A backup is never restored for any other purpose. Deleted client material has left every backup within 16 weeks of its deletion at most.",
      "Client material is not committed to the private GitHub repository that keeps the version history of turva.dev's own notes. Earlier versions of client files, the fourth kind of copy, exist only inside the backups and leave with them when the rotation replaces them.",
      "Credentials are held in an encrypted vault rather than in files, apart from the client test credentials described under AI tools. The cloud backup is encrypted on turva.dev's own network storage before it is uploaded.",
    ],
    public_site_briefs: [
      "When turva.dev measures a company's public website and sends a brief, the brief is published at an unlisted address on turva.dev. It contains public-site observations and the method used, not privately shared material. The address is not indexed or linked elsewhere. A brief is removed on request and expires no later than 400 days after its latest publication.",
    ],
    outreach_records: [
      "When turva.dev writes to a company, it records the company, the business contact it wrote to, the public page where that contact was found and the date. Keeping it stops the same company from being contacted twice and lets the promised rescan be sent. The lawful basis is legitimate interest, and the record is shown or removed on request.",
      "The record is kept for 24 months from the latest contact. A company that asks not to be contacted stays on an exclusion list for as long as that request stands, so that the request can be honored. You can object to this processing at any time, and an objection stops further contact.",
    ],
    ai_tools: [
      "The AI tool used in the work is Claude, apart from security work, which uses GLM 5.3 as the section AI tools in security work describes. Security work means active security testing, the MCP server security test and, in an audit, the internet.nl tests, the published security scans and the security headers of the client's domain. Security headers are the response headers that set a browser security policy: Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy and Cross-Origin-Resource-Policy, together with the report-only forms of those that have one. The other response headers are read in the rest of the audit. Writing and checking the report section on security work is security work too. In an MCP server security test, GLM 5.3 fills in and checks the whole report on a fixed template from turva.dev that holds no client material, and the test's scripted walkthrough uses no AI model.",
      "In the rest of an audit, client material, including what is read from a client's public site, is processed only through the Anthropic API, unless the engagement agreement names another route for part of the work at the client's request, such as Claude through Amazon Bedrock. That exception does not apply to security work, whose model route the section AI tools in security work covers. The recorded questions of an audit are put to the assistants named in the written scope in anonymous sessions and contain only the public product name and the question text, never client material.",
      "The API is used on Anthropic's commercial terms, with Anthropic Ireland, Limited as the contracting party. Anthropic's data processing addendum and the standard contractual clauses named under International transfers apply, and data can be transferred to Anthropic, PBC in the United States.",
      "Anthropic's retention article says that for the Anthropic API it deletes inputs and outputs within 30 days of receipt or generation. The exceptions it names are a service with longer retention, a different agreement, enforcement of its Usage Policy and the law. The same article says that inputs and outputs its systems flag under its Usage Policy are kept for up to two years and their trust and safety classification scores for up to seven years, that feedback sent to it is kept for five years, and it names limited retention for the safety review of the models it calls covered models.",
      "For client work, the AI tool is instructed to work only in the client's own folder, which holds only the files the task needs, inside the virtual machine described under Where the work runs. Credentials are held in an encrypted vault and read by scripts at runtime, so no secret sits in a file. The one exception is a client's test credentials for active security testing or the MCP server security test, which are made available to the test run in the virtual machine only during the test or retest window and are removed from it when that window ends. A copy can remain in the workstation's disk images, which include the virtual machine's disk file, until the rotation described under Client material replaces them. Vault storage and the permissions a tool has while running are separate controls, and each task has its own access limits.",
      "In an audit the tools read what the client's site and API serve publicly, and a test account is used only when the client names it in writing and the written scope states what it allows. In active security testing and the MCP server security test the tools send test traffic only to the targets named in the client's signed authorization. Material a client wants excluded from AI tooling is named in the non-disclosure agreement and excluded.",
    ],
    providers: [
      "No data is sold. Client material and correspondence reach only the providers needed for the work.",
      "Cloudflare, Inc. in the United States hosts the site. Proton AG in Switzerland provides email. Synology Inc. in Taiwan provides the encrypted cloud backup storage, in its Frankfurt region in Germany.",
      "Anthropic Ireland, Limited is the contracting party for Claude, and data can be transferred to Anthropic, PBC in the United States. Melious AI GmbH in Germany provides GLM 5.3, the model used in security work, and states that it runs the model on its own hardware in the facilities of DataCrunch Oy in Finland. Its agreement also names its own hardware at OVH SAS in France.",
      "Signal Messenger LLC in the United States carries messages sent over Signal. LinkedIn Ireland Unlimited Company, part of Microsoft, carries messages sent over LinkedIn. Masto.host in Portugal hosts the Mastodon server social.turva.dev and carries messages sent over Mastodon. The server's data is stored in France. A card payment made through a payment link is processed by Stripe.",
      "The audit's scanner, isitagentready.com, receives only the public address under test from turva.dev, reads the public site at that address itself and sees the connection data of the request. For an audit, internet.nl receives the domain under test, and turva.dev uses it as an ordinary user and not as a processor. The footer of isitagentready.com links Cloudflare's privacy policy, and internet.nl has its own privacy statement. internet.nl stores the tested domain, shows the result at a permanent link and can list the domain in its Hall of Fame, and turva.dev cannot remove the stored result itself. internet.nl's privacy statement treats domain names as public data and takes requests about personal data. Its email test checks secure connections to mail servers, which can be the email provider's servers. turva.dev runs the internet.nl tests on a client's domain only with the client's written permission.",
      "The Cloudflare 1.1.1.1 public DNS resolver receives the names that turva.dev queries, as its privacy page describes. The same page says that APNIC, Cloudflare's research partner for the resolver, can access query names and other metadata through a Cloudflare API.",
      "YTJ is the Finnish business information system run by the Finnish Patent and Registration Office and the Tax Administration. Looking up a Business ID there, a foreign register ID in that country's open register or a VAT ID in the EU's VIES service sends that ID to the public register or service.",
      "A new provider is added to this list before it receives client material.",
    ],
    data_rights: [
      "Send a request for access to, correction of, deletion of or restriction of personal data held about you to info@turva.dev. The same address takes a request for a portable copy of data you gave for an engagement. An objection to processing based on legitimate interest, which includes outreach, can be made at any time.",
      "The supervisory authority in Finland is the Data Protection Ombudsman (tietosuoja.fi). You can lodge a complaint with it or with the supervisory authority of the EU country where you live or work.",
    ],
    cookies: [
      "This site sets no cookies of its own. A check of the home page, this page and the contact page on 27 September 2026 received no cookie.",
      "If Cloudflare's bot protection is triggered, it can set one of its own security cookies, __cf_bm, which tells bot traffic apart from human visitors, or cf_clearance, which records that a challenge was passed, for that purpose only, as Cloudflare's own cookie table names them. Cloudflare describes __cf_bm as necessary for its bot protection to work and cf_clearance as required to reach the origin after a challenge. turva.dev treats both as strictly necessary for security and does not ask for consent for them.",
    ],
    // Added 2026-11-22 (outside read P6): the same ## Updates section as contract_terms.updates, which dates the privacy sections.
    updates: [
      "This page is updated when the terms or the privacy sections change. The terms apply to engagements started on or after the Terms date below, and the privacy sections apply from the Privacy date below.",
      "- **Terms last updated:** 2026-11-21\n- **Privacy last updated:** 2026-11-21",
    ],
    not_included: "The sections AI tools in security work and Where the work runs are on the legal page only.",
  },
} as const;

// One output schema per tool, written against the objects above. Every object is strict, so
// the SDK's check of structuredContent against the schema fails on a field the schema does
// not name, and test/protocol.test.ts calls every tool: a field added above without its
// schema fails the tests before it can fail a client.
//
// No tool reads its input. noArguments makes the published inputSchema say so with
// additionalProperties false, and a call that passes an argument anyway gets a tool error, a
// result with isError set to true, which is how the SDK reports every input validation failure.
const noArguments = z.strictObject({});

// A section of the legal page as an array of paragraphs, one string per paragraph, in the page's order.
const paragraphs = (what: string) => z.array(z.string().describe("One paragraph of the legal page, quoted as the page words it.")).describe(what);

const servicesOutput = z.strictObject({
  pricing_model: z.string().describe("The pricing model. fixed_list_prices means fixed list prices, apart from the services priced on request."),
  pricing_note: z.string().describe("The VAT treatment by customer type, the services quoted per engagement and the rule for the add-ons."),
  currency: z.string().describe("ISO 4217 code of every price, EUR."),
  vat_included: z.boolean().describe("Whether the prices include VAT. False means every price excludes VAT."),
  engagement: z.strictObject({
    communication: z.string().describe("How an engagement is communicated, async_only for written exchange with no calls."),
    notes: z.array(z.string().describe("One term of an engagement as a sentence.")).describe("Terms of an engagement, one per entry, covering access, scope, dates and completion."),
  }).describe("How an engagement is run."),
  services: z.array(z.strictObject({
    id: z.string().describe("Stable identifier of the service."),
    name: z.string().describe("The name of the service."),
    url: z.string().describe("The turva.dev page that describes the service."),
    sample_url: z.string().optional().describe("A published sample of the deliverable, where one exists."),
    price: z.union([z.number(), z.literal("on request")]).describe("EUR, VAT not included, or on request."),
    unit: z.string().optional().describe("What the price covers, such as fixed, month or day. Absent when the price is on request."),
    duration: z.string().optional().describe("How long delivery takes, where the service states one."),
    duration_from: z.string().optional().describe("The event the duration counts from, where the service states one."),
    minimum_commitment: z.string().optional().describe("The shortest term the service is sold for, where one applies."),
    summary: z.string().describe("What the service covers and its scope."),
    deliverable: z.string().describe("What the customer receives and when."),
  })).describe("The services with their prices."),
  bundled_implementation: z.array(z.strictObject({
    id: z.string().describe("Stable identifier of the add-on."),
    name: z.string().describe("The name of the add-on."),
    price: z.number().describe("Price in EUR, VAT not included."),
    unit: z.string().describe("What the price covers, such as fixed."),
    requires: z.string().describe("The id of the service this add-on is sold with."),
    sold_separately: z.boolean().describe("Whether the add-on can be bought without its service. False means it cannot."),
    summary: z.string().describe("What the add-on covers and when it is bought."),
    if_access_missing: z.string().describe("What happens when the required access cannot be arranged."),
  })).describe("Implementation add-ons that are sold only with another service."),
  quoted_add_ons: z.array(z.strictObject({
    id: z.string().describe("Stable identifier of the add-on."),
    name: z.string().describe("The name of the add-on."),
    url: z.string().describe("The page section that describes the add-on."),
    price: z.literal("on request").describe("The price is quoted for each written scope."),
    requires: z.string().describe("The id of the service this add-on is sold with."),
    sold_separately: z.boolean().describe("Whether the add-on can be bought without its service. False means it cannot."),
    summary: z.string().describe("What the add-on covers and when it starts."),
  })).describe("Add-ons to a service, priced by quote for each written scope."),
  contract_terms: z.strictObject({
    url: z.string().describe("The turva.dev legal page that states the terms."),
    applies_to: paragraphs("Which services the terms apply to and to whom they are sold."),
    scope: paragraphs("How the scope is agreed and what counts as the order."),
    business_days: paragraphs("What a business day means in the terms."),
    deliverables: paragraphs("What each service produces."),
    payment: paragraphs("When payment is due and what it does not depend on."),
    cancellation_and_refunds: paragraphs("The cancellation rules per service, the first-month opt-out of advisory, refunds and the correction of a deliverable that does not match its page."),
    delay: paragraphs("How dates in the written scope move and when the client can cancel."),
    continuity: paragraphs("What happens when the one person who runs turva.dev cannot work."),
    confidentiality: paragraphs("Confidentiality, non-disclosure agreements, data processing and access."),
    liability: paragraphs("The limit of liability."),
    intellectual_property: paragraphs("Who owns the deliverables and what turva.dev retains."),
    governing_law: paragraphs("The governing law and the court that resolves disputes."),
    updates: paragraphs("The Updates section of the legal page, which dates the terms and the engagements they apply to."),
  }).describe("The engagement terms of the legal page, every paragraph of every subsection, quoted as the page words them."),
  sample_report: z.strictObject({
    url: z.string().describe("The published sample audit report."),
    title: z.string().describe("The title of the sample report."),
    fictional: z.boolean().describe("Whether the sample is invented. True means the company and every reading in it are fictional."),
    sections: z.array(z.string().describe("The heading of one section.")).describe("Every section heading of the sample report, in order."),
    example_findings: z.array(z.string().describe("The heading of one finding, numbered F1 onward.")).describe("The headings of the example findings in the sample report, in order."),
  }).describe("The published sample audit report, a fictional worked example of the deliverable, with its sections and its example findings."),
});

const readinessOutput = z.strictObject({
  domain: z.string().describe("The domain the reading is about."),
  measured_at: z.string().describe("Date of the reading, YYYY-MM-DD."),
  note: z.string().describe("A caveat that the scores are a point-in-time reading by an independent scanner and that the scan url opens the scanner's start page."),
  scans: z.array(z.strictObject({
    provider: z.string().describe("The domain of the scanner that produced the reading."),
    result: z.string().describe("The scanner's overall result as text, giving the score out of 100 and the level reached."),
    note: z.string().describe("Who runs the scanner and a reminder that the reading is the scanner's and can be re-run by anyone."),
    categories: z.record(z.string(), z.string().describe("The category score as text, out of 100.")).describe("Sub-scores by category. Each key is a category name: discoverability, content, bot_access_control, api_auth_mcp_a2a_discovery or commerce."),
    url: z.string().describe("The scanner's start page, where a new check can be run. It does not show the recorded reading."),
  })).describe("Readings from independent scanners, one per entry."),
});

const securityOutput = z.strictObject({
  domain: z.string().describe("The domain the scans are about."),
  measured_at: z.string().describe("Date of the Internet.nl readings, YYYY-MM-DD. Every entry in scans carries its own measured_at, which is the date of that reading."),
  scans: z.array(z.strictObject({
    provider: z.string().describe("The name of the scan provider."),
    result: z.string().optional().describe("The overall result as text, for a provider that reports passed categories instead of a number. Absent when a numeric score is given."),
    score: z.number().optional().describe("The numeric score, on the range given in scale. Absent when the provider reports a text result."),
    scale: z.string().optional().describe("The range of the score, written as low-high. Absent when there is no numeric score."),
    note: z.string().optional().describe("What passed in full and where the points were lost. Absent when the provider adds no note."),
    measured_at: z.string().describe("Date of this reading, YYYY-MM-DD. It can equal the top-level date."),
    url: z.string().describe("The provider's public report page for the domain."),
  })).describe("Web-security scan results, one per provider and test."),
  note: z.string().describe("Why turva.dev publishes the scan results of its own domain."),
});

const principlesOutput = z.strictObject({
  model: z.string().describe("The service model the principles belong to, agent_readiness_audit for the agent-readiness audit."),
  rules: z.array(z.strictObject({
    id: z.string().describe("Stable identifier of the principle."),
    title: z.string().describe("The principle in a short phrase."),
    rationale: z.string().describe("What the principle means in practice and why it holds."),
  })).describe("The principles an engagement follows, one per entry."),
});

const contactOutput = z.strictObject({
  email: z.string().describe("The email address for starting an engagement."),
  signal: z.string().describe("A link that opens a Signal chat with the operator."),
  linkedin: z.string().describe("The URL of the operator's LinkedIn profile."),
  business_id: z.string().describe("The Finnish business ID of the business."),
  location: z.string().describe("The city and country where the business is based."),
  engagement: z.string().describe("How an engagement is communicated, async_only for written exchange with no calls."),
  correspondence_languages: z.array(z.string().describe("An ISO 639-1 language code.")).describe("ISO 639-1 codes of the languages the correspondence is held in."),
  first_reply: z.string().describe("How soon the first reply comes and by which channels, and that LinkedIn has no set reply time."),
  channel_note: z.string().describe("Which channel suits which kind of message, and that there are no calls."),
  how_to_start: z.array(z.string().describe("One step as a sentence.")).describe("The first steps to start an engagement, one per entry."),
  operator: z.strictObject({
    name: z.string().describe("The trading name of the business."),
    run_by: z.string().describe("The person who runs the business."),
    legal_form: z.string().describe("The legal form of the business."),
    business_id: z.string().describe("The Finnish business ID of the business."),
    vat_id: z.string().describe("The VAT identification number of the business."),
    location: z.string().describe("Where the business is based: city, region and country."),
    postal_address: z.string().describe("The postal address of the business."),
    team: z.string().describe("Who works at the business and how clients work with them."),
    background: z.string().describe("The professional background of the person who runs the business."),
    company_page: z.string().describe("The turva.dev page that states the business details."),
    legal_page: z.string().describe("The turva.dev page that states the terms, the privacy notice and how data is handled."),
  }).describe("Who runs turva.dev and the registered business behind it."),
  privacy: z.strictObject({
    url: z.string().describe("The turva.dev legal page that states the privacy notice."),
    overview: paragraphs("What the site does and does not use, and where cookies are described."),
    roles: paragraphs("The controller, the lawful bases, Article 14 and processing as a client's processor."),
    server_logs: paragraphs("The request logs, their retention, the analysis of a traffic spike and the llms.txt validator."),
    international_transfers: paragraphs("The transfer mechanisms for each provider outside the EEA."),
    email: paragraphs("How long email is kept and when it is deleted."),
    client_material: paragraphs("Where client material is stored, when it is deleted, backups and credentials."),
    public_site_briefs: paragraphs("How a brief about a company's public website is published."),
    outreach_records: paragraphs("What the record of a company that was written to holds, its lawful basis and its retention."),
    ai_tools: paragraphs("Which AI tool is used and how its provider handles the data."),
    providers: paragraphs("The providers that process data and what each one holds."),
    data_rights: paragraphs("The rights of a person whose data is processed and how to use them."),
    cookies: paragraphs("The cookies the site sets."),
    updates: paragraphs("The Updates section of the legal page, which dates the privacy sections."),
    not_included: z.string().describe("Which sections of the legal page this object leaves out."),
  }).describe("The privacy sections of the legal page, every paragraph of every section listed, quoted as the page words them. A markdown link is reduced to its text."),
});

// Every tool returns its data twice: as structuredContent, which its outputSchema describes,
// and as the same JSON in a text block for clients that read text only, as the revision
// recommends. Both come from the one object, so they cannot drift apart.
function dataResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// Read-only annotations, identical on all five tools. Declared once so the five
// registrations cannot drift apart, which is the same failure class the signed
// server card has already produced twice.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// A fresh server per request. The 2026-07-28 revision is stateless, and stateless here
// means that nothing survives the request, not that the endpoint refuses to shake hands.
// Measured live against https://mcp.turva.dev/mcp on 2026-09-02: an initialize call is
// answered normally, with serverInfo turva-mcp 1.3.9 and protocolVersion 2025-06-18
// negotiated by the SDK. What is absent is everything after it. The response carries no
// Mcp-Session-Id header, no session is kept alive, nothing here is shared between
// requests and no Durable Object is needed, so initialize is answered and then
// forgotten.
//
// Reworded twice on 2026-09-01. The original wording asserted that the handshake itself
// was absent, which would tell a reader that a standard MCP client cannot connect; it
// can. The first rewrite fixed the claim but QUOTED the wrong phrase verbatim while
// correcting it, which left the defect string in the file: three consecutive audit runs
// grepped it, found a real hit, and reported an already-fixed line as unfixed. The phrase
// is therefore described here and never repeated. General rule for this repo: a comment
// that corrects a claim states the correct claim, and does not carry the wrong one along
// as a quotation, because the file is read by grep before it is read by a person.
//
// server/discover is installed by the SDK itself and is deliberately not implemented by hand.
// What it returns is set here: the identity, the capabilities and the instructions.
//
// The identity carries the title and description of the serverInfo in the signed server
// card on turva.dev, and the card's websiteUrl, so a client that reads only the protocol
// sees what a reader of the card sees. Its version moves with package.json and the card.
const SERVER_INFO = {
  name: "turva-mcp",
  title: "turva.dev",
  version: "1.13.3",
  description: "Public read-only MCP server for turva.dev. Exposes the service catalog (audit, advisory, implementation, MCP server security test, agent operations, MCP server design) with prices, the active security testing add-on to the audit quoted on request, own-domain agent-readiness and web-security scan evidence, and engagement principles (async-only, no calls, no calendar links). No authentication, no write operations.",
  websiteUrl: "https://turva.dev/",
  icons: [
    { src: "https://turva.dev/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "https://turva.dev/logo.png", mimeType: "image/png", sizes: ["512x512"] },
  ],
};

// Each tool description repeats the routing to its neighbours, and this says it once for a
// client that reads server/discover, or initialize on the 2025-era lane, before it lists the
// tools.
const INSTRUCTIONS = "Five read-only tools answer questions about turva.dev itself. get_services answers for the services, their prices, the access an engagement needs, the full contract terms and the outline of the published sample report. For the standing principles behind every engagement and the reason for each, call get_principles. Call get_contact for who runs turva.dev, its business details, how to reach it and how it handles personal data. get_agent_readiness returns turva.dev's own agent-readiness score from the independent scanner isitagentready.com. get_security_evidence returns its own web and email security scan results, which are a separate measurement. For evidence in general, call both. No tool takes arguments. The data is compiled into the server, carries a date where it is a measurement, and changes only on deploy. This server does not scan or audit any site: for a fresh reading of a domain, turva.dev included, run the check on isitagentready.com itself.";

function createServer(): McpServer {
  const server = new McpServer(
    SERVER_INFO,
    {
      // listChanged is false because this server never sends notifications/tools/list_changed:
      // the five tools are compiled in and change only on deploy, and no request outlives its
      // response. @modelcontextprotocol/server set the flag to true at the first
      // registerTool unless the code that creates the server passes a value (measured on
      // 2.0.0 on 2026-09-23; protocol.test.ts P1 and P6 hold the outcome on the pinned
      // release). Without this line the endpoint advertises a notification it never sends,
      // and subscriptions/listen acknowledges a tools filter that can never fire.
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      // The revision requires ttlMs and cacheScope on every cacheable result. The SDK
      // would default them to 0 and private. These five tools are static data compiled
      // into the Worker, so the answer is byte-identical for every caller and changes
      // only on deploy: public is a true statement about this server, not an
      // optimization, and one hour is well inside how often it is redeployed.
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "get_services",
    {
      title: "Service catalog and pricing",
      description: "Returns turva.dev's service catalog and contract terms. The catalog covers the agent-readiness audit, advisory, implementation, the MCP server security test, agent operations and MCP server design. The audit, advisory and implementation have fixed list prices, and the other three are priced on request. One fixed-price implementation add-on, sold only with the audit it follows, is listed under bundled_implementation. Active security testing, an audit add-on priced by quote, is listed under quoted_add_ons. The engagement field holds the working terms of an engagement, including the access the audit and implementation need. Its contract_terms field quotes the engagement terms of the legal page in full: scope, business days, deliverables, payment, cancellation and refunds, delay, continuity, confidentiality, liability, intellectual property and governing law. The sample_report field describes the published sample audit report, a fictional worked example, with its sections and its nine example findings. Use this when a user asks what turva.dev offers or costs, what access an engagement needs, what the contract says, or what a delivered report contains. For the standing principles behind every engagement use get_principles, and for who runs turva.dev, how to reach it and how personal data is handled use get_contact. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: servicesOutput,
    },
    async () => dataResult(SERVICES),
  );

  server.registerTool(
    "get_agent_readiness",
    {
      title: "Agent-readiness score",
      description: "Returns how well AI agents can discover and use turva.dev, as scored by one independent public scanner, isitagentready.com: the overall score and level, the category sub-scores, the measurement date and a link to the scanner's start page, where a new check can be run. That link does not open the recorded reading. Use this when a user asks for turva.dev's agent-readiness score or level, or wants to check the readiness claim behind the audit service. It holds no TLS, DNS or email security results, which get_security_evidence returns. When a user asks for evidence in general, call both. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: readinessOutput,
    },
    async () => dataResult(AGENT_READINESS),
  );

  server.registerTool(
    "get_security_evidence",
    {
      title: "Web-security scan evidence",
      description: "Returns the web and email security scan results for turva.dev's own domain from three scans: Hardenize and two Internet.nl tests, one for the site and one for its mail. They cover HTTPS, DNSSEC, RPKI, IPv6 and email authentication, and each has its result, scan date and public report link. Use this when a user asks how turva.dev's own domain is secured or configured. It holds no agent-readiness score, which get_agent_readiness returns. When a user asks for evidence in general, call both. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: securityOutput,
    },
    async () => dataResult(SECURITY_EVIDENCE),
  );

  server.registerTool(
    "get_principles",
    {
      title: "Engagement principles",
      description: "Returns turva.dev's four engagement principles, each with its reason: async-only, least access, each fix checked with a scanner or a direct test, and open and verifiable. Use this when a user asks what turva.dev stands by or why it works the way it does, for example why there are no calls. For the terms of an engagement, its scope, access, dates, payment and prices, use get_services instead, and for how to start use get_contact. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: principlesOutput,
    },
    async () => dataResult(PRINCIPLES),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Contact and operator details",
      description: "Returns who runs turva.dev, how to reach it and how it handles personal data. The operator field gives the legal form, Business ID, VAT ID and postal address, with the team and the background. Beside it are the email address, the Signal link and the LinkedIn profile, with the correspondence languages, the first-reply time and the first steps to start an audit. The privacy field quotes the privacy sections of the legal page: the controller and lawful bases, server logs, international transfers, email, client material, public-site briefs, outreach records, AI tools, providers, data rights and cookies. Two legal page sections are left out: AI tools in security work, and where the work runs. Use this when a user asks who is behind turva.dev, for its legal details, how to contact it or start an audit, or how it handles personal data. For the services, prices, the access an engagement needs and the contract terms use get_services instead. Read-only: returns static JSON that is compiled into the Worker, so it changes nothing and updates only on deploy.",
      annotations: READ_ONLY,
      inputSchema: noArguments,
      outputSchema: contactOutput,
    },
    async () => dataResult(CONTACT),
  );

  return server;
}

// CORS for the MCP endpoint itself. Every value here is a claim about what this
// endpoint actually does, so none of it is copied from a default:
// - methods lists POST and OPTIONS only, because GET and DELETE were session
//   operations and now answer 405.
// - headers carries exactly the three the revision defines for a POST plus
//   Content-Type and Accept. mcp-session-id and last-event-id are gone from the
//   protocol, so advertising them would be a surface that does not exist.
// - origin is turva.dev rather than a wildcard, because allowedOriginHostnames
//   below actually enforces that list. A wildcard here would advertise access
//   that the Origin check then refuses.
const MCP_CORS = {
  origin: "https://turva.dev",
  methods: "POST, OPTIONS",
  headers: "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  exposeHeaders: "",
  maxAge: 86400,
};

// Browser Origins allowed to reach the endpoint. The list is explicit because relying
// on the handler's default would make this a derived surface: agents builds that
// default at request time (read on 0.20.1; protocol.test.ts holds the outcome on the pinned
// release) from the localhost class, the workers.dev hostname when that
// endpoint is enabled, and the hostname of corsOptions.origin, which here is turva.dev.
// Editing MCP_CORS.origin would then silently change who may reach the endpoint, and a
// wrong Origin list fails only for browsers: non-browser clients send no Origin at all,
// so it is invisible to curl and to every gate we run. "*" is not used either: it
// disables the Origin check the revision expects an HTTP MCP server to perform.
//
// This check compares hostnames only. The SDK parses the Origin as a URL and looks its
// hostname up in this list, so the scheme and the port take no part and the parse folds
// letter case: http://turva.dev and https://turva.dev:8443 pass as well as https://turva.dev.
// That is accepted on purpose. 8443 is one of the HTTPS ports Cloudflare serves the same
// zone on, every value this endpoint returns is public, and the list exists to keep other
// sites' pages out.
//
// Corrected 2026-08-16. This comment described the
// handler's default as covering nothing but the localhost class and the workers.dev
// hostname, and concluded that it would therefore reject every browser request.
// Measured against the pinned dependency, the default also adds the corsOptions.origin
// hostname, so it would have included turva.dev. The configuration is right; the reason
// written beside it was not.
const MCP_ALLOWED_ORIGIN_HOSTNAMES = ["turva.dev"];

// The discovery documents below are plain JSON read by directories and crawlers,
// not MCP traffic, so they keep the open cross-origin policy they have always had.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// The rate limit, written once: RateLimit-Policy and the 429 answer below are derived from
// it. wrangler.jsonc configures the binding with the same two numbers, and the binding
// exposes limit() alone, so test/protocol.test.ts compares the two files.
const RATE_LIMIT = { requests: 100, windowSeconds: 60 } as const;

// The same protections turva.dev applies to its agent-API responses. This endpoint is
// public, unauthenticated and read cross-origin by agents, so Cross-Origin-Resource-Policy
// is cross-origin while the rest is closed. Nothing here serves HTML or loads a subresource,
// so the policy is default-src none. RateLimit-Policy is sent because the limiter in fetch()
// below applies it. An advertised limit that no code applies is exactly the
// declared-but-unresolved surface this service audits for. It states the configured quota,
// not an exact ceiling. Cloudflare's rate-limiting binding counts per location and
// approximately: on 2026-09-23 a burst of 300 requests from one address in 5 seconds met its
// first 429 at about request 234, and 260 requests spread over 48 seconds all passed.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "RateLimit-Policy": `"default";q=${RATE_LIMIT.requests};w=${RATE_LIMIT.windowSeconds}`,
};

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  // The handler merges its own CORS defaults, so an empty exposeHeaders value still ships
  // as a present but valueless Access-Control-Expose-Headers line (measured 2026-07-29).
  // There is nothing on a response worth exposing once mcp-session-id is gone, and a header
  // that declares nothing is still a declared surface, so it is removed rather than emptied.
  if (headers.get("access-control-expose-headers") === "") headers.delete("access-control-expose-headers");
  // RFC 9110 requires an Allow header on a 405, and the handler's own 405 for GET and DELETE
  // has none. It names the methods the preflight advertises, from the same list.
  if (res.status === 405) headers.set("Allow", MCP_CORS.methods);
  // HTTP-04 (Astra audit 2026-09-26): a GET/DELETE 405 or an unmatched-method 404 on this
  // route carried no Cache-Control at all, so a shared cache was free to decide for itself
  // how long to keep an error that has nothing static about it.
  if (res.status === 404 || res.status === 405) headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// E-01 (Astra audit 2026-09-26): this server has no notifications to deliver, so a
// subscriptions/listen stream that stays open after its acknowledgement is pure overhead: an
// SDK keepalive timer and an open stream per caller that nothing here ever ends. The
// 2026-07-28 revision's Subscriptions pattern defines a Graceful Closure frame for exactly
// this, a JSON-RPC result carrying resultType "complete" and the subscription id, sent on the
// same stream before it ends. This reads the SDK's own acknowledgement frame through
// unchanged, cancels the SDK's stream (which runs its own teardown: clears the keepalive
// timer and unsubscribes from the notification bus), and appends the completion frame itself,
// so "no request outlives its response" (the comment above createServer) holds for this
// method too, as measured on 2026-09-26. Skipped when the response is not the SSE stream this
// method returns on success, such as the JSON-RPC error a subscription-limit or params
// rejection sends instead. The 2025-era lane (no MCP-Protocol-Version header) answers the
// unknown method as an SSE error frame; that case is relayed unchanged, because appending a
// result after an error would answer one request twice (G-48).
// True only when the chunk is one complete SSE frame whose JSON data is the acknowledgement
// notification. The method is read from the parsed data, never searched for as text, because a
// caller's own request id is echoed in an error frame and may contain the method name. A
// malformed or incomplete first frame is "not the acknowledgement".
function isAcknowledgementFrame(chunk: string): boolean {
  if (!chunk.endsWith("\n\n") || chunk.slice(0, -1).includes("\n\n")) return false;
  const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && (parsed as { method?: unknown }).method === "notifications/subscriptions/acknowledged";
  } catch {
    return false;
  }
}

// Exported only so a test can drive the relay branch with a stream of its own; the Worker's
// default export is the one entry point.
export function closeListenStreamAfterAck(res: Response, subscriptionId: string | number): Response {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || res.body === null) return res;
  const upstream = res.body.getReader();
  // Set by the cancel hook below, so the relay loop stops instead of enqueueing into a stream
  // its consumer has already cancelled.
  let cancelled = false;
  const encoder = new TextEncoder();
  const completeFrame = encoder.encode(`event: message\ndata: ${JSON.stringify({
    jsonrpc: "2.0",
    id: subscriptionId,
    result: {
      resultType: "complete",
      _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId, [SERVER_INFO_META_KEY]: SERVER_INFO },
    },
  })}\n\n`);
  const body = new ReadableStream({
    async start(controller) {
      const { value } = await upstream.read();
      if (value === undefined || !isAcknowledgementFrame(new TextDecoder().decode(value))) {
        // Not the acknowledgement: relay what the SDK sent, to its end, and add nothing.
        if (value !== undefined) controller.enqueue(value);
        for (;;) {
          const next = await upstream.read();
          if (next.done || cancelled) break;
          controller.enqueue(next.value);
        }
        if (!cancelled) controller.close();
        return;
      }
      try {
        controller.enqueue(value);
      } finally {
        await upstream.cancel();
      }
      controller.enqueue(completeFrame);
      controller.close();
    },
    // A downstream cancel used to stop at this
    // wrapper and never reach the SDK's stream, so on the relay branch above its keepalive timer
    // and bus subscription would have outlived the caller. The pinned SDK (2.4.0) does not take
    // that branch with a stream that stays open: its first chunk is always the acknowledgement
    // and the 2025-era lane ends its own stream. This is insurance for an SDK update.
    cancel(reason) {
      cancelled = true;
      return upstream.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// The narrow /mcp policy applied to a response the MCP handler never sees, so a rate-limited
// answer describes the same endpoint the same way an accepted one does.
function withMcpCorsHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", MCP_CORS.origin);
  headers.set("Access-Control-Allow-Methods", MCP_CORS.methods);
  headers.set("Access-Control-Allow-Headers", MCP_CORS.headers);
  headers.set("Access-Control-Max-Age", String(MCP_CORS.maxAge));
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// The discovery documents change only on deploy, so a client may keep them for the same hour
// the cacheHints above give tools/list and server/discover.
const DISCOVERY_CACHE_CONTROL = "public, max-age=3600";

// RFC 9110, section 9.3.2, defines HEAD as a GET without the body. Cloudflare's edge already
// strips a HEAD body in production, and answering without one here keeps the Worker correct
// on its own.
function discoveryDocument(head: boolean, doc: Record<string, unknown>): Response {
  return withHeaders(new Response(head ? null : JSON.stringify(doc), {
    headers: { "Content-Type": "application/json", "Cache-Control": DISCOVERY_CACHE_CONTROL },
  }));
}

// Limits the SDK leaves to its host, applied to a POST on /mcp before the handler sees it.
// Measured on 2026-09-23 in audit round 20: the 2025-era lane answered a JSON-RPC batch of 100
// tools/call requests sent in one POST, which the limiter counts as one request, and no size
// limit applied, so a 50 MB body was read into memory whole. The 2026-07-28 lane already
// refuses a batch, and this refuses it on both lanes. A request that belongs to the
// 2026-07-28 lane, by its body envelope or by its Mcp-Method header, must also carry
// MCP-Protocol-Version: the revision requires the header, and the SDK reads the version from
// the body alone, so without this check it answers a request that lacks the header.
// Notifications are left to the SDK, which checks its own required headers on requests only.
const MAX_BODY_BYTES = 65_536;

// P19 (Astra audit 2026-09-26, 32/T2-03): the SDK answers an unknown tool name with
// "Tool <name> not found", echoing whatever the caller sent, without a length limit.
// unknownToolError below reads that name only up to this many characters, keeps it in a
// data field of its own instead of the message text, and marks a longer name as cut.
const MAX_ECHOED_TOOL_NAME_LENGTH = 64;

// The SDK's schema check names every unrecognized argument key without a length limit, and a
// client should hand that tool error to the model, so caller text in it is model context
// (MCP 2026-07-28, Error Handling). A key of 2 000 characters came back whole in 2 085
// characters of text, measured 2026-11-02 on 1.7.1. These two limits bound the echo: a key is
// cut at the same length as a tool name, and at most this many keys are listed.
const MAX_ECHOED_ARGUMENT_KEY_LENGTH = 64;
const MAX_ECHOED_ARGUMENT_KEYS = 5;

// The lane of a request, read from its header alone and in one place. The 2026-07-28 lane is a
// request that carries exactly MCP-Protocol-Version: 2026-07-28. Every other request is the
// legacy lane: no header, a legacy revision and an unknown version too, which is also how the
// SDK treats a request without the header. An OPTIONS preflight carries no such header and is
// not a JSON-RPC request, so a refused one is answered as the legacy lane.
function isModernLane(request: Request): boolean {
  return request.headers.get("MCP-Protocol-Version") === "2026-07-28";
}

// T-02 (Astra audit 2026-09-26), refined in the S5 round (2026-11-05) and after the C3 protocol
// test (2026-11-22): the 2026-07-28 revision's JSONRPCErrorResponse allows id to be a string, an
// integer (the schema's RequestId is string or integer), or absent, and nothing else,
// so an error on that lane leaves the id out when none was read, which is most callers of this
// function (an oversized body, a batch). The legacy lane follows JSON-RPC 2.0 section 5
// instead: a request whose id could not be read is answered with id null. `modern` is the
// lane from isModernLane. A caller that knows the request's id (the mismatch check and the
// T-01/T-04 checks below) passes it explicitly and gets it on either lane.
function mcpError(modern: boolean, status: number, code: number, message: string, id?: string | number, data?: Record<string, unknown>): Response {
  const idField = id !== undefined ? { id } : modern ? {} : { id: null };
  return withMcpCorsHeaders(Response.json(
    { jsonrpc: "2.0", error: { code, message, ...(data === undefined ? {} : { data }) }, ...idField },
    { status },
  ));
}

// The id a request can carry under the 2026-07-28 revision's RequestId: a string or an integer.
// An integer outside the safe range is not counted, because it cannot be echoed exactly.
function isReadableRequestId(value: unknown): value is string | number {
  return typeof value === "string" || Number.isSafeInteger(value);
}

// C3 finding 2 (MCP protocol test 2026-11-22): the 2026-07-28 revision marks -32000 to -32019 as
// a legacy sub-range that new implementations SHOULD NOT use, and -32020 to -32099 holds only
// the codes the specification itself defines. A refusal at the transport layer (an oversized
// body, a disallowed Origin, a body not declared as JSON, a method /mcp does not serve) is
// therefore answered on that lane with the standard JSON-RPC code -32600 Invalid Request, and
// the HTTP status still names the reason. The legacy lane keeps -32000, the code the SDK gives
// these answers there. The set of refused requests does not move, only the code on one lane.
const LEGACY_TRANSPORT_REFUSAL_CODE = -32000;
const MODERN_TRANSPORT_REFUSAL_CODE = -32600;
function transportRefusalCode(modern: boolean): number {
  return modern ? MODERN_TRANSPORT_REFUSAL_CODE : LEGACY_TRANSPORT_REFUSAL_CODE;
}

// MCP-05 (S5 triage 2026-11-05): the SDK answers its own errors with "id":null on both lanes
// (invalid request, 405, a refused Origin), which the 2026-07-28 revision does not allow. On
// that lane only, the id member is taken out of such a JSON answer. C3 finding 1 (2026-11-22):
// the SDK also echoed an id the revision's RequestId does not allow, such as 1.5, so every id
// that is neither a string nor a safe integer is taken out the same way. C3 finding 2: an SDK
// error with the legacy code -32000 (its 405, for example) gets the lane's transport refusal
// code. The answer is rebuilt without the old Content-Length, and the status, the headers and
// the error message stay as they were. The legacy lane keeps the SDK's answer.
async function modernLaneAnswer(res: Response): Promise<Response> {
  if (res.body === null || !(res.headers.get("Content-Type") ?? "").includes("application/json")) return res;
  const text = await res.text();
  let out = text;
  try {
    const body: unknown = JSON.parse(text);
    if (isPlainObject(body)) {
      let next: Record<string, unknown> = body;
      if ("id" in next && !isReadableRequestId(next.id)) {
        const { id: _unreadableId, ...rest } = next;
        next = rest;
      }
      if (isPlainObject(next.error) && next.error.code === LEGACY_TRANSPORT_REFUSAL_CODE) {
        next = { ...next, error: { ...next.error, code: MODERN_TRANSPORT_REFUSAL_CODE } };
      }
      if (next !== body) out = JSON.stringify(next);
    }
  } catch {
    // Not JSON after all: handed on as it was.
  }
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}

// MCP-09 (S5 triage 2026-11-05): an Origin header that is present must be a serialized origin,
// so it equals the origin of its own parse. The SDK compares the hostname only, which let a
// path, userinfo, a fragment or a trailing slash through. An empty value is present and
// malformed, the same as the literal null; an absent header is a non-browser client and passes.
// http://turva.dev and https://turva.dev:8443 are serialized origins and stay accepted (see the
// comment on MCP_ALLOWED_ORIGIN_HOSTNAMES). The message text is the SDK's own.
// The refusal text echoes the caller's Origin, which the platform allows to be several
// kilobytes. The whole message is therefore capped at 96 characters: a longer one is cut at 96
// and ends in "...". With the 23 character prefix "Invalid Origin header: " that lets 73 of
// the caller's characters through whole. The status and code are unchanged, and so is the
// message of every Origin short enough to fit.
const MAX_ORIGIN_ERROR_MESSAGE_LENGTH = 96;
function cappedOriginMessage(message: string): string {
  return message.length > MAX_ORIGIN_ERROR_MESSAGE_LENGTH ? message.slice(0, MAX_ORIGIN_ERROR_MESSAGE_LENGTH) + "..." : message;
}

function checkedOrigin(raw: string | null): { ok: true } | { ok: false; message: string } {
  if (raw === null) return { ok: true };
  if (raw === "") return { ok: false, message: "Invalid Origin header: " };
  const sdk = validateOriginHeader(raw, MCP_ALLOWED_ORIGIN_HOSTNAMES);
  if (!sdk.ok) return { ok: false, message: cappedOriginMessage(sdk.message) };
  let serialized: string | undefined;
  try {
    serialized = new URL(raw).origin;
  } catch {
    serialized = undefined;
  }
  return serialized === raw ? { ok: true } : { ok: false, message: cappedOriginMessage(`Invalid Origin header: ${raw}`) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The five names server.registerTool gives below, every one with noArguments as its
// inputSchema. protocol.test.ts asserts this list matches tools/list's own names, so the two
// cannot drift apart silently.
export const NO_ARGUMENT_TOOL_NAMES = ["get_services", "get_agent_readiness", "get_security_evidence", "get_principles", "get_contact"] as const;
const NO_ARGUMENT_TOOLS = new Set<string>(NO_ARGUMENT_TOOL_NAMES);

// T-01 (Astra audit 2026-09-26): the SDK's
// own request-schema validation throws a plain Error, not a ProtocolError, when a known
// method's params fail its wire schema, and setRequestHandler's function-overload catch maps
// any thrown value without a numeric .code to ProtocolErrorCode.InternalError (-32603). A
// client's malformed params then reads as a server fault. This checks only the exact
// malformed shapes measured (initialize missing params, capabilities or clientInfo, a
// non-string protocolVersion, or a clientInfo whose name or version is not a string;
// tools/list with a non-string cursor), before the SDK ever sees the request, and answers
// -32602 Invalid params instead. Anything the SDK itself accepts is left to it unchanged, so
// the accepted set does not move.
//
// MCP-04 (S5 triage 2026-11-05): for initialize the SDK's own InitializeRequestParams schema
// now decides (specTypeSchemas, exported by @modelcontextprotocol/server, so no new zod import
// and no bundle growth to measure beyond that export). Nested capabilities and clientInfo
// fields of the wrong type used to pass the hand-written checks and read -32603 with the schema
// library's issue list as the message. The answer names the path of the first issue only.
//
// Astra audit 2026-09-28, 3rd round: the checks above covered protocolVersion
// and capabilities but not clientInfo, so a malformed clientInfo (for example a string in
// place of the object) reached the SDK's own schema check unguarded and read -32603 Internal
// error, the same class of bug T-01 fixed for the other two fields.
// A capabilities.experimental about 5 000 levels
// deep (30 kB, under the body cap) passed the check below and then overflowed the stack inside
// the SDK's schema library, which answered 400 with "RangeError: Maximum call stack size
// exceeded" in the data field and left an unhandled promise rejection. Params nested deeper than
// this are refused before any schema runs, counting params itself as level 1, so
// capabilities.experimental.a is level 4. 64 is far above what a client sends (capabilities,
// clientInfo and _meta nest 3 to 5 levels) and far below the roughly 1 000 levels where the
// overflow starts. The count is iterative, so it cannot overflow the stack itself.
const MAX_PARAMS_DEPTH = 64;

function nestsDeeperThan(value: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[value, 1]];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const [current, level] = item;
    if (typeof current !== "object" || current === null) continue;
    if (level > limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) pending.push([child, level + 1]);
  }
  return false;
}

function invalidParamsReason(method: string, params: unknown): string | undefined {
  if (nestsDeeperThan(params, MAX_PARAMS_DEPTH)) return `params are nested more than ${MAX_PARAMS_DEPTH} levels deep`;
  if (method === "initialize") {
    if (!isPlainObject(params)) return "params must be an object";
    const parsed = specTypeSchemas.InitializeRequestParams["~standard"].validate(params);
    if (parsed.issues !== undefined) {
      // A caller-chosen key in the path is cut like the argument keys (MAX_ECHOED_ARGUMENT_KEY_LENGTH).
      const path = (parsed.issues[0].path ?? []).map((part) => String(typeof part === "object" ? part.key : part).slice(0, MAX_ECHOED_ARGUMENT_KEY_LENGTH));
      return `${["params", ...path].join(".")} is invalid`;
    }
  }
  if (method === "tools/list" && params !== undefined) {
    if (!isPlainObject(params)) return "params must be an object";
    if ("cursor" in params && typeof params.cursor !== "string") return "params.cursor must be a string";
  }
  return undefined;
}

function argumentKeysExceedEchoLimits(keys: string[]): boolean {
  return keys.length > MAX_ECHOED_ARGUMENT_KEYS || keys.some((k) => k.length > MAX_ECHOED_ARGUMENT_KEY_LENGTH);
}

// T-04 (Astra audit 2026-09-26): every tool above takes noArguments, z.strictObject({}), but
// a JSON body whose arguments object has "__proto__" as its only key got past that check,
// although README and every other extra key promise a tool error. Test P13 still fails without
// this branch (measured 2026-11-04). The SDK's spread of the raw params, "{ ...request.params }",
// is not the mechanism: an object spread copies "__proto__" as an ordinary own property, and only
// a "{ __proto__: x }" literal and Object.assign set a prototype from that key. Where the SDK path
// loses the key has not been traced. JSON.parse always creates "__proto__" as a real own data
// property, so Object.keys on the parsed body still sees it: this reads that raw object,
// before the SDK handles it, and answers the same tool error (isError true)
// a normal extra key already gets (Tek-458), never a JSON-RPC protocol error. It acts only
// when "__proto__" is among the keys, the one key the SDK path lets through, or when the keys exceed
// the echo limits above. Every other extra key still reaches the SDK's own check and keeps its
// own message, and every case stays the same refusal, so the accepted set does not move.
// W16 F1 (ChatGPT review 2026-10-02): the 2026-07-28 revision requires resultType on every result, so
// the modern lane gets "complete" here as the SDK adds it on every other result. The legacy lane
// keeps its earlier bytes.
// C3 finding 7 (MCP protocol test 2026-11-22): servers SHOULD include
// io.modelcontextprotocol/serverInfo in every result's _meta, and the SDK's own tool errors on
// the 2026-07-28 lane carry it, so this result carries the same SERVER_INFO there too.
function toolArgumentError(id: string | number, toolName: string, keys: string[], modern: boolean): Response {
  const listed = keys.slice(0, MAX_ECHOED_ARGUMENT_KEYS).map((k) => `'${k.slice(0, MAX_ECHOED_ARGUMENT_KEY_LENGTH)}'`).join(", ");
  const more = keys.length > MAX_ECHOED_ARGUMENT_KEYS ? ` and ${keys.length - MAX_ECHOED_ARGUMENT_KEYS} more` : "";
  return withMcpCorsHeaders(Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: `Input validation error: Invalid arguments for tool ${toolName}: unrecognized key(s) in object: ${listed}${more}` }],
      isError: true,
      ...(modern ? { resultType: "complete", _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO } } : {}),
    },
  }, { status: 200 }));
}

// P19 (Astra audit 2026-09-26, 32/T2-03): pre-checks a tools/call name against the five
// tools this server registers (NO_ARGUMENT_TOOL_NAMES above), before the SDK reaches it
// and echoes an unrecognised name verbatim into "Tool <name> not found". The caller's
// name is capped at MAX_ECHOED_TOOL_NAME_LENGTH and carried in its own data field, never
// spliced into the message string.
function unknownToolError(modern: boolean, id: string | number, toolName: string): Response {
  const truncated = toolName.length > MAX_ECHOED_TOOL_NAME_LENGTH;
  const name = truncated ? toolName.slice(0, MAX_ECHOED_TOOL_NAME_LENGTH) : toolName;
  return mcpError(modern, 200, -32602, "Invalid params: unknown tool name", id, { tool: { name, truncated } });
}

// C3 finding 6 (MCP protocol test 2026-11-22): a tools/call whose params fail the SDK's own
// request schema (no name, or arguments that are a string, a list or null) was answered -32602
// with the schema library's issue list as the message, 213 to 300 characters over several
// lines, on both lanes. initialize answers the same class with the path of the first issue
// alone (invalidParamsReason below), and this gives tools/call the same plain form. The SDK
// still decides what fails, so the accepted set does not move: only the message of that one
// answer is replaced. The legacy lane answers as an event stream and the 2026-07-28 lane as
// JSON, and both are read.
const TOOLS_CALL_SCHEMA_ERROR_PREFIX = "Invalid tools/call request: ";

function plainToolsCallSchemaMessage(message: string): string {
  let path: unknown[] = [];
  try {
    const issues: unknown = JSON.parse(message.slice(TOOLS_CALL_SCHEMA_ERROR_PREFIX.length));
    if (Array.isArray(issues) && isPlainObject(issues[0]) && Array.isArray(issues[0].path)) path = issues[0].path;
  } catch {
    // Not the issue list after all: the message then names params alone.
  }
  // The SDK checks the whole request, so its path starts at params. A caller-chosen key in it is
  // cut like the argument keys (MAX_ECHOED_ARGUMENT_KEY_LENGTH).
  const parts = path.map((part) => String(part).slice(0, MAX_ECHOED_ARGUMENT_KEY_LENGTH));
  return `Invalid params: ${(parts[0] === "params" ? parts : ["params", ...parts]).join(".")} is invalid`;
}

function rewrittenToolsCallMessage(json: string): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isPlainObject(message) || !isPlainObject(message.error)) return undefined;
  const text = message.error.message;
  if (message.error.code !== -32602 || typeof text !== "string" || !text.startsWith(TOOLS_CALL_SCHEMA_ERROR_PREFIX)) return undefined;
  return JSON.stringify({ ...message, error: { ...message.error, message: plainToolsCallSchemaMessage(text) } });
}

async function withPlainToolsCallSchemaError(res: Response): Promise<Response> {
  const type = res.headers.get("Content-Type") ?? "";
  const json = type.includes("application/json");
  if (res.body === null || !(json || type.includes("text/event-stream"))) return res;
  const text = await res.clone().text();
  let out: string | undefined;
  if (json) {
    out = rewrittenToolsCallMessage(text);
  } else {
    let changed = false;
    const lines = text.split("\n").map((line) => {
      if (!line.startsWith("data: ")) return line;
      const next = rewrittenToolsCallMessage(line.slice("data: ".length));
      if (next === undefined) return line;
      changed = true;
      return "data: " + next;
    });
    if (changed) out = lines.join("\n");
  }
  if (out === undefined) return res;
  await res.body.cancel();
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}

// C3 finding 13 (MCP protocol test 2026-11-22, Erik's decision the same day): MCP 2026-07-28
// says servers that process the request body MUST reject a request whose headers do not match
// it, with 400 -32020 HeaderMismatch. The SDK makes that comparison, but the Worker's own checks
// below (params, an unknown tool name, argument keys) answered first, with 200 -32602 or a tool
// error. On the 2026-07-28 lane those checks now ask this function first, and it runs the SDK's
// own entry ladder in the SDK's order. First classifyInboundRequest, which the SDK exports and
// its handler runs before anything else: the _meta envelope, the version the body names against
// the header, Mcp-Method against the body, an initialize sent with the modern header and a
// modern header without the envelope claim. Its rejection is answered as the SDK answers it,
// status, code, message and data unchanged. Then the unsupported-revision answer the SDK gives
// next, and last the part of validateStandardRequestHeaders the SDK does not export (a missing
// Mcp-Method and, for tools/call, the Mcp-Name header with its Base64 sentinel decoded), copied
// with the SDK's wording; there every value the caller chose is echoed at most
// MAX_ECHOED_TOOL_NAME_LENGTH characters long, as the tool name is elsewhere. The classifier
// reads a body nested deeper than the params limit without overflowing (measured 2026-11-22 up
// to 10 000 levels in params, arguments and _meta; a 64 KiB body holds about 10 900). A request
// no Worker check answers still reaches the SDK unchanged, so its answer keeps the SDK's own
// bytes, and the set of refused requests does not move.
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// The SDK's decodeMcpParamValue: a value in the sentinel is canonical Base64 of UTF-8 text, any
// other value is taken as it is, and undefined means a sentinel that does not decode.
function decodedNameHeader(value: string): string | undefined {
  if (!(value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX))) return value;
  const encoded = value.slice(BASE64_SENTINEL_PREFIX.length, value.length - BASE64_SENTINEL_SUFFIX.length);
  if (!CANONICAL_BASE64.test(encoded)) return undefined;
  try {
    // ignoreBOM false is the platform default, named because the Workers types require the member.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function headerMismatchAnswer(request: Request, body: Record<string, unknown>, method: string, params: unknown, id: string | number): Response | undefined {
  const asData = (value: unknown) => (isPlainObject(value) ? value : undefined);
  const headers = {
    ...(request.headers.has("MCP-Protocol-Version") ? { protocolVersionHeader: request.headers.get("MCP-Protocol-Version")! } : {}),
    ...(request.headers.has("Mcp-Method") ? { mcpMethodHeader: request.headers.get("Mcp-Method")! } : {}),
    ...(request.headers.has("Mcp-Name") ? { mcpNameHeader: request.headers.get("Mcp-Name")! } : {}),
  };
  const outcome = classifyInboundRequest({ httpMethod: "POST", ...headers, body });
  if (outcome.kind === "reject") return mcpError(true, outcome.httpStatus, outcome.code, outcome.message, id, asData(outcome.data));
  if (outcome.kind !== "modern" || outcome.messageKind !== "request") return undefined;
  const revision = outcome.classification.revision;
  if (revision !== MODERN_PROTOCOL_VERSION) {
    const unsupported = new UnsupportedProtocolVersionError({ supported: [MODERN_PROTOCOL_VERSION], requested: revision ?? "unknown" });
    return mcpError(true, 400, unsupported.code, unsupported.message, id, asData(unsupported.data));
  }
  const cap = (value: string) => value.slice(0, MAX_ECHOED_TOOL_NAME_LENGTH);
  const mismatch = (header: string, reason: string) =>
    mcpError(true, 400, -32020, `Bad Request: the request headers and body disagree: ${reason}`, id, { mismatch: { header, body: reason } });
  const methodHeader = request.headers.get("Mcp-Method");
  if (methodHeader === null) return mismatch("(missing)", `the body names method ${cap(method)} but the required Mcp-Method header is absent`);
  if (method !== "tools/call" || !isPlainObject(params) || typeof params.name !== "string") return undefined;
  const nameHeader = request.headers.get("Mcp-Name");
  if (nameHeader === null) return mismatch("(missing)", `the body carries params.name="${cap(params.name)}" but the required Mcp-Name header is absent`);
  const decoded = decodedNameHeader(nameHeader);
  if (decoded === undefined) return mismatch(cap(nameHeader), "the Mcp-Name header carries an invalid Base64 sentinel value");
  if (decoded !== params.name) return mismatch(cap(nameHeader), `the body carries params.name="${cap(params.name)}" but the Mcp-Name header names "${cap(decoded)}"`);
  return undefined;
}

// Reads the body chunk by chunk and stops at the limit, so an oversized body is never held
// whole, including one sent without a Content-Length header.
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function guardMcpPost(request: Request): Promise<{ request: Request; listenSubscriptionId?: string | number; toolsCall: boolean } | Response> {
  const modern = isModernLane(request);
  const tooLarge = () => mcpError(modern, 413, transportRefusalCode(modern), `Content Too Large: the request body may be at most ${MAX_BODY_BYTES} bytes`);
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) return tooLarge();
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (bytes === null) return tooLarge();
  let listenSubscriptionId: string | number | undefined;
  let toolsCall = false;
  // A body not declared as JSON is refused with 415 below, after the Origin check and before
  // the SDK, which would answer the same 415 with "id":null. The checks that read the body
  // as JSON-RPC therefore run only when the Content-Type is JSON. The Origin check runs for
  // every Content-Type.
  const contentTypeIsJson = isJsonContentType(request.headers.get("Content-Type"));
  let body: unknown;
  if (contentTypeIsJson) {
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // W16 U1 (ChatGPT review 2026-10-02): answered here, because the SDK answers a parse error
      // with "id":null, which the 2026-07-28 revision does not allow. The id field is left out on
      // that lane and null on the legacy lane (see mcpError). The Origin check runs first so a
      // disallowed Origin keeps its 403.
      const early = checkedOrigin(request.headers.get("Origin"));
      if (!early.ok) return mcpError(modern, 403, transportRefusalCode(modern), early.message);
      return mcpError(modern, 400, -32700, "Parse error: Invalid JSON");
    }
    if (Array.isArray(body)) {
      return mcpError(modern, 400, -32600, "Bad Request: JSON-RPC batches are not supported by this endpoint");
    }
  }
  // B1 (Astra audit 2026-09-28): T-01 and T-04 below used to
  // answer a malformed request before guardMcpPost reached the SDK's own Origin check
  // (createMcpHandler, allowedOriginHostnames), so a disallowed Origin combined with a
  // malformed params shape or a raw "__proto__" key got -32602 or a tool error instead
  // of the 403 every other request from that Origin gets. This applies the SDK's own
  // rule (validateOriginHeader, exported by @modelcontextprotocol/server: a missing Origin
  // passes, any other value is parsed as a URL and its hostname checked against the same
  // MCP_ALLOWED_ORIGIN_HOSTNAMES createMcpHandler is given below) through checkedOrigin,
  // which adds the serialized-origin rule, and answers with the same message text, and with the
  // same code on the legacy lane (the 2026-07-28 lane gets -32600, see transportRefusalCode).
  // None has been read yet, so the id member follows the lane (B2; see mcpError): absent on
  // the 2026-07-28 lane, null on the legacy lane. It runs after the batch check above and the
  // oversized-body check at the top of this function, which is the order decided for the guard
  // before the Origin check (Tek-458 P7): a disallowed Origin still reads 400 for a batch and 413 for an oversized
  // body, never 403, because the memory limit and the batch refusal are answered before
  // Origin is even considered.
  //
  // Astra audit 2026-09-28, 3rd round: B1/B2 above used to run only inside the
  // JSON-Content-Type branch, so a POST whose Content-Type is not JSON skipped this check
  // entirely and fell through unchanged to the SDK's own Origin check, which still answers
  // a disallowed Origin with "id":null. Checking the Origin here, before any
  // Content-Type-specific handling, gives every Content-Type the same code, message and
  // id shape for its lane.
  const originResult = checkedOrigin(request.headers.get("Origin"));
  if (!originResult.ok) return mcpError(modern, 403, transportRefusalCode(modern), originResult.message);
  // Same condition and message as the SDK's own check (isJsonContentType in handle()), and the
  // same code on the legacy lane (the 2026-07-28 lane gets -32600, see transportRefusalCode),
  // answered here with the lane's id shape because the SDK sends "id":null, which the
  // 2026-07-28 revision does not allow. A header the SDK accepts, such as application/json with
  // a charset, still reaches it.
  if (!contentTypeIsJson) {
    return mcpError(modern, 415, transportRefusalCode(modern), "Unsupported Media Type: Content-Type must be application/json");
  }
  if (contentTypeIsJson) {
    // A single-object body with a string method and no usable id (a notification) has no result
    // to return, so a params tree nested deeper than the limit is refused here with a plain 400
    // and a fixed message, no data field and the id member of its lane (mcpError: null on the
    // legacy lane, absent on the 2026-07-28 lane), before the SDK's schema library can overflow
    // the stack on it. Notifications nested within the limit pass to the SDK unchanged.
    if (isPlainObject(body) && typeof body.method === "string"
      && !(typeof body.id === "string" || Number.isSafeInteger(body.id))
      && nestsDeeperThan(body.params, MAX_PARAMS_DEPTH)) {
      return mcpError(modern, 400, -32600, `Invalid Request: params are nested more than ${MAX_PARAMS_DEPTH} levels deep`);
    }
    // C3 finding 5 (MCP protocol test 2026-11-22): a request whose method is missing or not a
    // string, with an id that can be read, was left to the SDK, which answered 400 -32600 with
    // no id on the 2026-07-28 lane and id null on the legacy lane, although an error must carry
    // the id of the request it answers whenever that id can be read. The Worker answers it
    // itself with the SDK's code and message and that id, on both lanes. A body with a result or
    // an error member is a client's JSON-RPC response, not a request, and still reaches the SDK.
    if (isPlainObject(body) && typeof body.method !== "string" && isReadableRequestId(body.id)
      && !("result" in body) && !("error" in body)) {
      return mcpError(modern, 400, -32600, "Bad Request: the request body is not a valid JSON-RPC message", body.id as string | number);
    }
    // MCP-03 (S5 triage 2026-11-05): the guards below act only on a well-formed request
    // envelope: jsonrpc "2.0", a string method, and a string or safe-integer id, the same as
    // the SDK's own check. Anything else is left to the SDK, which answers 400 with -32600; it
    // echoes a readable id when jsonrpc is wrong or absent (measured 2026-11-22, C3 FM17 and
    // FM18), and the case where it did not, a missing or non-string method, is answered above.
    if (isPlainObject(body) && body.jsonrpc === "2.0" && typeof body.method === "string"
      && (typeof body.id === "string" || Number.isSafeInteger(body.id))) {
      // C3 finding 13: on the 2026-07-28 lane a header that disagrees with the body is answered
      // before any of the three Worker checks below (headerMismatchAnswer).
      const requestBody = body;
      const requestMethod = body.method;
      const requestId = body.id as string | number;
      const requestParams = body.params;
      const ownAnswer = (answer: () => Response): Response =>
        (modern ? headerMismatchAnswer(request, requestBody, requestMethod, requestParams, requestId) : undefined) ?? answer();
      const paramsProblem = invalidParamsReason(body.method, body.params);
      if (paramsProblem !== undefined) {
        return ownAnswer(() => mcpError(modern, 200, -32602, `Invalid params: ${paramsProblem}`, requestId));
      }
      if (body.method === "tools/call" && isPlainObject(body.params) && typeof body.params.name === "string"
        && !NO_ARGUMENT_TOOLS.has(body.params.name)) {
        const toolName = body.params.name;
        return ownAnswer(() => unknownToolError(modern, requestId, toolName));
      }
      if (body.method === "tools/call" && isPlainObject(body.params) && typeof body.params.name === "string"
        && NO_ARGUMENT_TOOLS.has(body.params.name) && isPlainObject(body.params.arguments)) {
        const keys = Object.keys(body.params.arguments);
        const toolName = body.params.name;
        if (keys.includes("__proto__") || argumentKeysExceedEchoLimits(keys)) return ownAnswer(() => toolArgumentError(requestId, toolName, keys, modern));
      }
      if (body.method === "subscriptions/listen") listenSubscriptionId = body.id as string | number;
      if (body.method === "tools/call") toolsCall = true;
      if (!request.headers.has("MCP-Protocol-Version")) {
        const meta = isPlainObject(body.params) && isPlainObject(body.params._meta) ? body.params._meta : undefined;
        const claim = meta !== undefined && PROTOCOL_VERSION_META_KEY in meta;
        if (claim || request.headers.has("Mcp-Method")) {
          const reason = claim
            ? "the body carries the per-request protocol version envelope but the required MCP-Protocol-Version header is absent"
            : "the Mcp-Method header is present but the required MCP-Protocol-Version header is absent";
          // The same shape and code the SDK gives a missing Mcp-Method header.
          return mcpError(modern, 400, -32020, `Bad Request: the request headers and body disagree: ${reason}`, body.id as string | number, { mismatch: { header: "(missing)", body: reason } });
        }
      }
    }
  }
  return { request: new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal }), listenSubscriptionId, toolsCall };
}

// Typed structurally rather than against an ambient binding type, so the shape this code
// depends on is visible here and a workers-types bump cannot change it silently.
interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  RATE_LIMITER?: RateLimiterBinding;
}

// An IPv6 client usually holds a whole /64, so keying on the full address would hand one
// client 2^64 separate buckets. The key for IPv6 is therefore the /64 prefix; IPv4 stays the
// full address, and an IPv4-mapped IPv6 address (::ffff:a.b.c.d) counts as that IPv4 address.
// Anything that does not parse falls back to the header value itself, so a strange value can
// only share or split a bucket and never throws. The key is never logged.
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

function expandIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const dotted = i === pieces.length - 1 ? IPV4_PATTERN.exec(piece) : null;
      if (dotted) {
        const octets = dotted.slice(1).map(Number);
        if (octets.some((o) => o > 255)) return undefined;
        groups.push(octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!);
      } else if (IPV6_GROUP.test(piece)) {
        groups.push(parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

export function rateLimitKey(header: string | null): string {
  const raw = (header ?? "").trim();
  if (raw === "") return "no-ip";
  if (IPV4_PATTERN.test(raw)) return raw;
  if (!raw.includes(":")) return raw;
  const withoutZone = raw.split("%")[0]!.toLowerCase();
  const groups = expandIpv6(withoutZone);
  if (!groups) return raw;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  return groups.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
}

// One warning per isolate, so a deployment that lost its rate-limit binding shows up in a
// live tail (wrangler tail) without the log filling with one line per request. Workers
// observability is off in wrangler.jsonc, so nothing is stored. The warning carries no
// request data and no address.
let warnedMissingLimiter = false;
export function resetRateLimiterWarningForTests(): void {
  warnedMissingLimiter = false;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Applied before anything else, so a burst from one address meets the limiter before it
    // reaches the MCP handler. The binding counts per Cloudflare location and approximately,
    // as the note on RATE_LIMIT above says, so it slows a burst down rather than cutting it
    // at an exact count. Fail open: a missing or erroring binding serves the request normally
    // instead of taking the endpoint down.
    if (env.RATE_LIMITER) {
      try {
        // Cloudflare's edge sets CF-Connecting-IP on every request it passes to the Worker.
        // The fallback key covers a request without the header, such as a local test, and
        // all such requests share one bucket.
        const key = rateLimitKey(request.headers.get("CF-Connecting-IP"));
        const { success } = await env.RATE_LIMITER.limit({ key });
        if (!success) {
          const limited = new Response(
            `429 Too Many Requests. This endpoint allows about ${RATE_LIMIT.requests} requests per ${RATE_LIMIT.windowSeconds} seconds per client IP. Each Cloudflare location keeps its own approximate count, so a burst can pass more requests before this answer. Retry after ${RATE_LIMIT.windowSeconds} seconds.\n`,
            { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(RATE_LIMIT.windowSeconds) } },
          );
          // The limiter runs before path routing, so without this the 429 answered with the
          // discovery routes' wildcard policy on /mcp too, advertising both a wildcard origin
          // and a GET method that /mcp itself refuses with 405.
          const limitedPath = new URL(request.url).pathname;
          return limitedPath === "/mcp" || limitedPath === "/mcp/"
            ? withMcpCorsHeaders(limited)
            : withHeaders(limited);
        }
      } catch (err) {
        console.error("Rate limiter error (failing open):", err instanceof Error ? err.stack : String(err));
      }
    } else if (!warnedMissingLimiter) {
      warnedMissingLimiter = true;
      console.warn("RATE_LIMITER binding is missing: requests are served without a rate limit (failing open).");
    }
    const url = new URL(request.url);
    const preflight = request.method.toUpperCase() === "OPTIONS";
    // A trailing slash is a common way to mistype the endpoint. 308 keeps the method and the
    // body, so a POST that follows it reaches /mcp unchanged, and the query string is kept.
    // Location is a path and not a URL built from the request, so it can only point at this
    // host. A preflight is the exception: a browser does not follow a redirect on one, so
    // OPTIONS /mcp/ is answered below as the preflight for /mcp.
    if (url.pathname === "/mcp/" && !preflight) {
      return withMcpCorsHeaders(new Response(null, { status: 308, headers: { Location: "/mcp" + url.search } }));
    }
    // /mcp is handled first and including its preflight, because the handler owns both
    // the CORS answer and the Origin check for that path. Answering OPTIONS here instead
    // would advertise a permission the handler then refuses on the POST that follows.
    // A POST passes guardMcpPost first, for the limits the SDK does not set.
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      let forwarded = url.pathname === "/mcp" ? request : new Request(new URL("/mcp" + url.search, url), request);
      let listenSubscriptionId: string | number | undefined;
      let toolsCall = false;
      if (request.method.toUpperCase() === "POST") {
        const guarded = await guardMcpPost(request);
        if (guarded instanceof Response) return guarded;
        forwarded = guarded.request;
        listenSubscriptionId = guarded.listenSubscriptionId;
        toolsCall = guarded.toolsCall;
      } else {
        // OPTIONS, GET and DELETE get the same Origin rule as a POST, here before the SDK's
        // own hostname-only check (MCP-09). A preflight has no version header, so a refusal
        // of one is the legacy answer.
        const origin = checkedOrigin(request.headers.get("Origin"));
        const modern = isModernLane(request);
        if (!origin.ok) return mcpError(modern, 403, transportRefusalCode(modern), origin.message);
      }
      const handled = await createMcpHandler(createServer, {
        route: "/mcp",
        corsOptions: MCP_CORS,
        allowedOriginHostnames: MCP_ALLOWED_ORIGIN_HOSTNAMES,
      })(forwarded, env, ctx);
      // MCP-05 and C3 findings 1 and 2: on the 2026-07-28 lane an SDK answer carries no id the
      // revision does not allow and no legacy -32000 code. C3 finding 6: a tools/call schema
      // error names the path of the first issue instead of the schema library's issue list.
      const modernChecked = isModernLane(request) ? await modernLaneAnswer(handled) : handled;
      const res = toolsCall ? await withPlainToolsCallSchemaError(modernChecked) : modernChecked;
      return withSecurityHeaders(listenSubscriptionId === undefined ? res : closeListenStreamAfterAck(res, listenSubscriptionId));
    }
    if (request.method === "OPTIONS") {
      return withHeaders(new Response(null, { status: 204 }));
    }
    // The discovery documents are read-only. CORS_HEADERS above promises GET and OPTIONS,
    // and until round 16 (C7-1, measured 2026-09-03) POST and DELETE on / answered 200 with
    // the same body, so the header was a claim the routing did not keep. HEAD is a GET
    // without the body and stays allowed.
    if (request.method !== "GET" && request.method !== "HEAD") {
      // HTTP-04 (Astra audit 2026-09-26): no-store, the same as the /mcp 405 above.
      return withHeaders(new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD, OPTIONS", "Cache-Control": "no-store" } }));
    }
    const head = request.method === "HEAD";
    if (url.pathname === "/" || url.pathname === "/.well-known/mcp") {
      return discoveryDocument(head, { name: "turva-mcp", transport: "streamable-http", endpoint: "https://mcp.turva.dev/mcp" });
    }
    if (url.pathname === "/.well-known/glama.json") {
      return discoveryDocument(head, { "$schema": "https://glama.ai/mcp/schemas/connector.json", maintainers: [{ email: "info@turva.dev" }] });
    }
    // HTTP-04 (Astra audit 2026-09-26): this 404 carried no Cache-Control, so a shared cache
    // was free to decide for itself how long to keep an error that has nothing static about it.
    return withHeaders(new Response(head ? null : "Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }));
  },
} satisfies ExportedHandler<Env>;
