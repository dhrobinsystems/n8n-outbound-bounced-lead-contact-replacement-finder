# n8n Outbound Bounced Lead Contact Replacement Finder

I built this because a hard bounce in an outbound campaign usually means the person left, and the account is still a fit. Instead of letting that account go quiet, this workflow catches the bounce in Smartlead or Instantly, finds a peer with the same buying persona and seniority at the same company domain through Apollo (with an optional Clay fallback), verifies the new address, logs the swap in HubSpot, enrolls the peer into the active sequence, and suppresses the bounced contact.

It ships safe by default. `DRY_RUN=true` and `SANDBOX_MODE=true` out of the box, so the first import runs end to end on synthetic `zzz_TEST_` data with no credentials and no writes anywhere.

## What is in the repo

| File | Purpose |
| --- | --- |
| `workflow.json` | Importable n8n workflow (v1.x, `executionOrder: v1`), 54 nodes plus 9 sticky notes |
| `mirror-cli.js` | Zero-dependency Node 18+ mirror of every decision the workflow makes, with 44 offline tests |
| `scripts/build-workflow.js` | Regenerates `workflow.json` so every Code node embeds the exact core from `mirror-cli.js` |
| `package.json` | npm scripts for tests, parity, simulation, and sending test payloads |
| `.env.example` | Every variable, with placeholders and safe defaults |
| `sample-payloads/` | Synthetic Smartlead and Instantly bounce webhooks, plus HubSpot and Apollo fixtures |
| `DISCLAIMER.md`, `LICENSE` | Liability limitation and MIT license |

## Architecture

```
 Smartlead / Instantly                          Clay table (async, optional)
 bounce webhook                                 callback webhook
 POST /webhook/outbound-bounce?token=...        POST /webhook/outbound-bounce-clay-callback
          |                                               |  x-callback-token
          v                                               v
 +---------------------------------+          +--------------------------+
 | Normalize & Classify            |          | Validate Clay Callback   |
 |  token check, provider detect,  |          |  token, context, email   |
 |  hard / soft / policy / unknown |          +------------+-------------+
 |  sandbox: zzz_TEST_ + RFC 2606  |                       |
 +----------------+----------------+                       |
     ignore <-----+ hard                                   |
                  v                                        |
 +---------------------------------+ <---------------------+
 | Context Hub                     |   both entry points share one path from here
 +----------------+----------------+
                  v
 +---------------------------------+     sandbox: synthetic empty HubSpot state
 | HubSpot reads (parallel)        |     live:    contacts at domain + company
 |  -> Hard-Bounce Suppression &   |
 |     Loop Gate (fails closed)    |---- blocked --> audit
 +----------------+----------------+
                  v
 +---------------------------------+
 | Domain & Persona Extractor      |  title -> department + seniority tier
 +----------------+----------------+
                  v
 +---------------------------------+     no peer passes scoring
 | Apollo People API Search        |---------------------------> Clay fallback request
 |  (or synthetic / Clay result)   |                             (live only) or audit
 |  -> Score & Rank                |
 |  -> Apollo Bulk People Match    |  reveals work emails for the top N
 +----------------+----------------+
                  v
 +---------------------------------+
 | Candidate Suppression &         |  opt-out, DNC, prior bounce, stage,
 | Email Verification Gate         |  source status, optional ZeroBounce
 +----------------+----------------+---- none deliverable --> audit
                  v
 +---------------------------------+
 | Build Swap Plan & Diff          |  exact request bodies + readable diff
 +----------------+----------------+
                  | Live Mode? (DRY_RUN=false AND SANDBOX_MODE=false)
        no -------+------- yes
        |                  v
        |    +---------------------------------+
        |    | HubSpot CRM Contact Upsert      |  replacement + bounced quarantine
        |    | & Bounced Contact Quarantine    |  in one batch upsert, then a note
        |    +----------------+----------------+
        |                     v
        |    +---------------------------------+
        |    | Smartlead / Instantly           |  enroll replacement,
        |    | Sequence Enrollment             |  unsubscribe or blocklist bounced
        |    +----------------+----------------+
        v                     v
 +----------------------------------------------+
 | Slack Audit Alert                            |  every outcome, plus HTTP errors
 +----------------------------------------------+
```

### How a bounce is classified

| Class | Signals | Result |
| --- | --- | --- |
| hard | provider marks it hard, SMTP `5.1.x`, bad-mailbox text such as "user unknown" or "does not exist" | processed |
| soft | provider marks it soft, any `4xx` or `4.x.x`, "mailbox full", "try again" | ignored |
| policy | `5.7.x`, spam, blocklist, reputation, DMARC, SPF, DKIM text | ignored, since the mailbox may still exist |
| unknown | no detail, or detail that matches nothing | ignored unless `ASSUME_HARD_WHEN_UNSPECIFIED=true` |

Free-mail domains are ignored too, since there is no company to find a peer at.

### How a peer is scored

The bounced title is mapped to a department (Revenue Operations, Sales, Marketing, Customer Success, Finance, People, IT, Engineering, Product, Operations) and a seniority tier (entry, senior, manager, head, director, VP, C-suite or partner, founder or owner). Apollo is asked for people at the same domain with related titles and seniorities within one tier. Each candidate scores out of 100:

| Component | Points |
| --- | --- |
| Same department | 50 |
| Shared title keywords | 5 each, up to 15 |
| Seniority distance 0 / 1 / 2 tiers | 25 / 15 / 5 |
| Source email status is `verified` | 10 |

Anything under `MIN_MATCH_SCORE` (default 60) is dropped, which in practice means a different department never qualifies. The same person, the same email, and other domains are excluded before scoring. Ties break on seniority distance, then on Apollo id, so the order is deterministic.

### Suppression and loop guards

The account gate runs before any Apollo call and fails closed. It blocks a replacement when any of these is true:

- the domain already has `MAX_REPLACEMENTS_PER_ACCOUNT` replacements (default 2, hard ceiling 5), counted from contacts that carry `outbound_replacement_of`;
- the bounced contact is itself a replacement at the generation limit, so a chain of bounces cannot run forever;
- the bounced contact is already quarantined, which makes webhook replays harmless;
- the company or any contact at the domain is in `BLOCKED_LIFECYCLE_STAGES` (default `opportunity,customer,evangelist`);
- the company has open deals (`hs_num_open_deals > 0`);
- any contact at the domain replied inside `REPLY_LOOKBACK_DAYS` (`hs_sales_email_last_replied` or your own `outbound_last_reply_at`);
- the company is flagged `outbound_dnc`, or the domain is in `SUPPRESSED_DOMAINS`;
- a HubSpot read failed, or the domain has more than 100 contacts so the result was truncated.

Each candidate then gets its own check: HubSpot opt-out (`hs_email_optout`), `outbound_dnc`, a prior bounce, already a replacement elsewhere, blocked lifecycle stage, or an email domain that does not match. On the sequencer side, Smartlead enrollment keeps global block lists and unsubscribe lists active, and Instantly enrollment uses `skip_if_in_workspace`.

If you keep do-not-contact rules as a HubSpot list, have a HubSpot workflow stamp `outbound_dnc=true` on list members. The gate reads the property, which is one search call instead of one list call per candidate.

### Clay fallback

Clay is asynchronous, so the workflow does not wait for it. When Apollo finds no qualifying peer and Clay is enabled (live mode only), the workflow posts a request row to your Clay webhook table with the full bounce context and stops. Configure an HTTP API column in that table to POST the enriched person back to the **Clay Callback Webhook** with header `x-callback-token: <CLAY_CALLBACK_SECRET>` and a body shaped like this:

```json
{
  "context": { "bounced": { "...": "the context object you received" }, "classification": { "...": "..." } },
  "candidate": { "first_name": "", "last_name": "", "title": "", "email": "", "email_status": "verified" }
}
```

The callback re-enters at Context Hub, so the full suppression gate runs again on fresh HubSpot data before anything is enrolled. A Clay result can never trigger a second Clay request.

## Prerequisites

- n8n 1.x (self-hosted or cloud plan that allows environment variables in expressions and Code nodes).
- On the n8n host: `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, otherwise `$env` reads fail. n8n reads environment variables at process start, so restart n8n after any change.
- Node.js 18 or newer for `mirror-cli.js`.
- HubSpot private app, Apollo API key, Smartlead or Instantly API key, Slack incoming webhook. Clay and ZeroBounce are optional.

### HubSpot custom properties

Create these on the **Contact** object before going live (Settings, Properties). Names must match exactly.

| Property | Type | Written by |
| --- | --- | --- |
| `outbound_bounce_status` | Single-line text | workflow, on the bounced contact |
| `outbound_bounce_reason` | Single-line text | workflow, on the bounced contact |
| `outbound_replaced_by` | Single-line text | workflow, on the bounced contact |
| `outbound_dnc` | Single checkbox | workflow on the bounced contact; you on anyone else |
| `outbound_replacement_of` | Single-line text | workflow, on the replacement |
| `outbound_replacement_generation` | Number | workflow, on the replacement |
| `outbound_replacement_source` | Single-line text | workflow, on the replacement |
| `outbound_replacement_swapped_at` | Single-line text (ISO timestamp) | workflow, on the replacement |
| `outbound_last_reply_at` | Date picker or datetime | your reply sync (optional, read only) |

Optional on **Company**: `outbound_dnc` (single checkbox).

## Environment variables

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `DRY_RUN` | `true` | yes | Anything other than an explicit `false` keeps it on |
| `SANDBOX_MODE` | `true` | yes | Synthetic records only, no CRM or enrichment API calls, writes always blocked |
| `WEBHOOK_SHARED_SECRET` | none | outside sandbox | Compared in constant time to `?token=` or `x-webhook-token` |
| `SMARTLEAD_API_KEY` | none | Smartlead users | Sent as the `api_key` query parameter, which is how Smartlead's API authenticates |
| `INSTANTLY_API_KEY` | none | Instantly users | API v2 key with permission to create leads and block list entries |
| `REPLACEMENT_CAMPAIGN_ID` | empty | no | Enroll into this campaign instead of the bounced contact's campaign |
| `APOLLO_API_KEY` | none | live | People API Search may need a master key on your plan; Bulk People Match spends credits |
| `APOLLO_ENRICH_TOP_N` | `2` | no | How many ranked peers get email enrichment (1 to 5) |
| `APOLLO_PER_PAGE` | `25` | no | Search page size (1 to 100) |
| `HUBSPOT_ACCESS_TOKEN` | none | live | Private app scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`. If the note call returns 403, add the scope HubSpot lists for the Notes API |
| `CLAY_ENABLED` | `false` | no | Turns on the async fallback |
| `CLAY_WEBHOOK_URL` | none | with Clay | Your Clay table webhook URL |
| `CLAY_WEBHOOK_AUTH_TOKEN` | none | with Clay | Sent as `x-clay-webhook-auth` if your table requires it |
| `CLAY_CALLBACK_SECRET` | none | with Clay | Required for the callback to be accepted |
| `VERIFIER_PROVIDER` | `none` | no | `none` or `zerobounce`. Any other value rejects every candidate |
| `ZEROBOUNCE_API_KEY` | none | with ZeroBounce | One credit per checked address |
| `ACCEPT_EMAIL_STATUSES` | `verified` | no | Source statuses that count as deliverable |
| `ALLOW_CATCH_ALL` | `false` | no | Accept ZeroBounce `catch-all` results |
| `MAX_REPLACEMENTS_PER_ACCOUNT` | `2` | no | Clamped to 0 through 5. `0` disables replacements |
| `REPLY_LOOKBACK_DAYS` | `30` | no | Any reply at the domain inside this window blocks the swap |
| `MIN_MATCH_SCORE` | `60` | no | Persona match threshold out of 100 |
| `BLOCKED_LIFECYCLE_STAGES` | `opportunity,customer,evangelist` | no | HubSpot internal stage values |
| `SUPPRESSED_DOMAINS` | empty | no | Comma-separated domains that never get a replacement |
| `FREE_MAIL_DOMAINS` | built-in list | no | Override the list of public mailbox providers |
| `ASSUME_HARD_WHEN_UNSPECIFIED` | `false` | no | See the Instantly note below |
| `SLACK_WEBHOOK_URL` | none | no | Without it, audit messages are skipped |
| `SLACK_NOTIFY_IGNORED` | `false` | no | Also post soft, policy, and unknown bounces |
| `SLACK_REDACT_EMAILS` | `false` | no | Mask addresses in Slack, for example `j***@domain` |
| `N8N_BOUNCE_WEBHOOK_URL` | none | CLI only | Your n8n test webhook URL for `npm run send:*` |

### Rate limits and retries

Every HTTP node retries 3 times with 3 seconds between attempts, then routes the failure to the error branch instead of stopping silently. Apollo calls are batched at one request per 1.2 seconds, Smartlead and Instantly at one per second, ZeroBounce at one per 0.5 seconds. Each bounce makes at most two HubSpot reads, two Apollo calls, `APOLLO_ENRICH_TOP_N` ZeroBounce calls, and four writes, so normal bounce volume stays well under the published limits. Limits differ by plan and change over time, so check the current numbers for HubSpot, Apollo, Smartlead, Instantly, and ZeroBounce before a bulk backfill, and raise the batch intervals if you replay many bounces at once.

### Provider payload notes

The normalizer reads several common field names for each provider (for example `to_email`, `sl_lead_email`, `lead_data.email` for Smartlead and `lead_email`, `firstName`, `jobTitle` for Instantly). Webhook payloads differ by account and API version, so I capture one real test event from each provider in n8n first and confirm the fields map before trusting the output.

Instantly bounce events may not include an SMTP code or reason. Without that detail the classifier returns `unknown` and the event is ignored. If you have checked your payloads and Instantly only sends this event for hard bounces, set `ASSUME_HARD_WHEN_UNSPECIFIED=true`.

The job title comes from the payload first (Smartlead custom field `job_title`, Instantly `jobTitle`), then from the HubSpot contact. With no title, the run stops at "no persona" rather than guessing.

## Safe deployment and testing runbook

Each stage has to pass before the next one starts.

### Stage 0: offline, on your laptop

```bash
npm test                    # 44 unit and pipeline tests, plus workflow parity
npm run simulate:smartlead  # full pipeline on the Smartlead sample, prints the dry-run diff
npm run simulate:instantly
npm run simulate:blocked    # same bounce against a HubSpot fixture that must block it
node mirror-cli.js simulate sample-payloads/smartlead-hard-bounce.json --json
```

The sandbox run picks `zzz_TEST_Riley Vance` (Head of Revenue Operations, verified) over `zzz_TEST_Jordan Pike`, who matches the title exactly but has a `guessed` email. That is the verification gate doing its job. The blocked run must report `max_replacements_reached` and `open_opportunity`.

### Stage 1: n8n sandbox, no credentials

1. Set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on the n8n host and restart it. Leave `DRY_RUN` and `SANDBOX_MODE` unset or `true`.
2. Import `workflow.json` (Workflows, Import from File). Do not activate it.
3. Open **Bounce Webhook**, click **Listen for test event**, copy the test URL into `.env` as `N8N_BOUNCE_WEBHOOK_URL`.
4. Run `npm run send:smartlead`, then `npm run send:instantly`. The CLI refuses any payload that is not a `zzz_TEST_` record on an RFC 2606 domain.
5. Check the execution. It should end at **Audit: Dry Run Diff** with the same diff the mirror printed. Add `SLACK_WEBHOOK_URL` (pointed at a test channel) to see the audit message.
6. Edit a sample payload to a soft bounce (`"bounce_code": "452"`, `"bounce_reason": "4.2.2 mailbox full"`) and confirm it ends at **Audit: Ignored**.

### Stage 2: real reads, still dry run

1. Set `SANDBOX_MODE=false`, keep `DRY_RUN=true`, and add `WEBHOOK_SHARED_SECRET`, `HUBSPOT_ACCESS_TOKEN`, `APOLLO_API_KEY`. Restart n8n.
2. Send the `zzz_TEST_` payloads again. HubSpot is now read for real (it returns nothing for `.example` domains), and synthetic records still use synthetic candidates, so no Apollo credits are spent.
3. Point one live campaign's bounce webhook at the **production** URL with `?token=<WEBHOOK_SHARED_SECRET>` and activate the workflow. Real bounces now flow through real HubSpot reads, Apollo search, and enrichment, and only a diff is produced. Note that dry run still spends Apollo enrichment credits (and ZeroBounce credits if enabled), because the diff needs real addresses.
4. Read the dry-run diffs in Slack for at least a week. Check persona matches, blocked reasons, and anything that looks wrong. Tune `MIN_MATCH_SCORE`, `BLOCKED_LIFECYCLE_STAGES`, and `SUPPRESSED_DOMAINS`.

### Stage 3: first live write, on a test campaign

1. Create the HubSpot custom properties above. Create a paused Smartlead or Instantly test campaign and add one `zzz_TEST_` lead to it on an `.example` domain.
2. Copy a sample payload, set its `campaign_id` (and Smartlead `sl_email_lead_id`) to that test campaign and lead.
3. Set `DRY_RUN=false`, restart n8n, send the edited payload to the test URL.
4. Confirm in HubSpot: the replacement contact has `outbound_replacement_of`, the bounced contact shows `hard_bounced_quarantined` and `outbound_dnc`, and a note exists. Confirm in the sequencer: the replacement is in the test campaign and the bounced lead is unsubscribed or blocklisted.
5. Send the same payload again. It must stop at the gate with `already_processed`.
6. Delete the `zzz_TEST_` records from HubSpot and the test campaign.

### Stage 4: production

1. Set `REPLACEMENT_CAMPAIGN_ID` if replacements should go to a dedicated sequence.
2. Point each campaign's bounce webhook at the production URL with `?token=`.
3. Activate the workflow and watch the first ten swaps in Slack.

**Kill switch:** deactivate the workflow in n8n. That takes effect immediately. Setting `DRY_RUN=true` also works but needs an n8n restart.

## Editing the logic

All decisions live between the `// <core` and `// </core>` markers in `mirror-cli.js`. The generator copies that block into every Code node, so the workflow and the mirror cannot drift without the parity check failing.

```bash
# edit mirror-cli.js, then:
npm test
npm run build:workflow   # regenerates workflow.json and runs the parity check
```

Re-import `workflow.json` afterwards. Embedding the core in each Code node makes the file around 750 KB, which imports fine but is the trade-off for having no shared-library dependency inside n8n.

## Known limits

- Replacement counting relies on the contact search at the domain. Domains with more than 100 HubSpot contacts are blocked for manual review rather than guessed.
- Domain matching is exact or subdomain based. Companies that use several unrelated domains need those domains handled by hand.
- Smartlead's bounced lead unsubscribe needs the lead id from the webhook; payloads without it are ignored.
- Writes are not transactional. If enrollment fails after the HubSpot upsert, the Slack error alert says so and the swap needs finishing by hand. The replacement still counts toward the account limit, which keeps a retry from creating a second one.

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-outbound-bounced-lead-contact-replacement-finder`) are for educational and architectural demonstration purposes.

- **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts and workflows.
- **CRM Data, Outbound Enrollment & Enrichment Risks:** Outbound automation carries inherent risks. Misconfigured filters, wrong persona matches, incorrect property mappings, bad API calls, or aggressive retries can enroll the wrong people into live sequences, email contacts who should be suppressed, overwrite or quarantine CRM records, spend Apollo, Clay, or ZeroBounce credits, exhaust API rate limits, damage sender reputation, or flood Slack channels. In live mode (`DRY_RUN=false` and `SANDBOX_MODE=false`) the workflow writes to HubSpot (upserts contacts, sets quarantine and DNC properties, creates notes), to Smartlead or Instantly (adds leads to campaigns, unsubscribes or blocklists the bounced address), and to Clay (sends enrichment requests). In dry-run mode it only reads, though enrichment still spends credits; in sandbox mode it calls no CRM, enrichment, or sequencer API.
- **User Responsibility:** You are solely responsible for compliance with applicable laws, regulations, and contracts, including outbound and data-protection rules (such as CAN-SPAM, GDPR, PECR, CCPA, and CASL), having a lawful basis to contact replacement prospects, API rate limits, and the terms of service of HubSpot, Apollo, Clay, ZeroBounce, Smartlead, Instantly, Slack, n8n, and any other provider you connect. You are also solely responsible for proper testing (`SANDBOX_MODE=true`, `DRY_RUN=true`) before connecting any scripts to production environments, live CRM data, live campaigns, or live notification channels.

Full text: [DISCLAIMER.md](./DISCLAIMER.md) · Licensed under the [MIT License](./LICENSE).

## License

MIT © 2026 dhRobin Systems · Provided as-is, see the [disclaimer](./DISCLAIMER.md).
