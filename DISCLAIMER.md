# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-outbound-bounced-lead-contact-replacement-finder`) are for educational and architectural demonstration purposes. They are a blueprint, not a managed service, and they are not tailored to your business, your data, or your legal obligations.

## 1. No Warranty

This software is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, accuracy, non-infringement, uninterrupted operation, or error-free operation. No advice or information, oral or written, obtained from the author or dhRobin Systems creates any warranty not expressly stated in the [MIT License](./LICENSE).

## 2. No Liability

To the maximum extent permitted by applicable law, the author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, exemplary, punitive, or consequential damages resulting from the use, misuse, inability to use, or deployment of these scripts and workflows. This includes, without limitation: lost revenue or pipeline, lost or corrupted CRM data, damaged sender or domain reputation, suspended sending accounts, spent or wasted API and enrichment credits, regulatory fines, third-party claims, and costs of procuring replacement services, even if advised of the possibility of such damages.

If any part of this limitation is held unenforceable, liability is limited to the greatest extent the law allows, and in no case exceeds the amount you paid for this software (which is zero).

## 3. CRM Data, Outbound Enrollment & Enrichment Risks

Outbound automation carries inherent risks. Misconfigured filters, wrong persona matches, incorrect property mappings, bad API calls, stale suppression data, or aggressive retries can:

- enroll the wrong person into a live sequence, or email someone who should have been suppressed;
- overwrite, quarantine, or mark as do-not-contact the wrong CRM records;
- spend Apollo, Clay, or ZeroBounce credits, including during `DRY_RUN`, because the dry-run diff needs real enrichment and verification results;
- exhaust API rate limits on HubSpot, Apollo, Smartlead, Instantly, or Slack;
- harm sender or domain reputation if a replacement address later bounces;
- flood Slack channels with audit messages.

**What this workflow writes, and when.** Only when both `DRY_RUN=false` and `SANDBOX_MODE=false`:

| System | Writes |
| --- | --- |
| HubSpot | Upserts the replacement contact, sets quarantine and DNC properties on the bounced contact, creates a note |
| Smartlead | Adds the replacement lead to a campaign, unsubscribes the bounced lead from its campaign |
| Instantly | Adds the replacement lead to a campaign, adds the bounced email to the block list |
| Clay | Sends an enrichment request row to your Clay table (when `CLAY_ENABLED=true`) |

With `DRY_RUN=true` and `SANDBOX_MODE=false`, the workflow reads from HubSpot, Apollo, and (if enabled) ZeroBounce, writes nothing to any CRM or sequencer, and posts a Slack audit message. With `SANDBOX_MODE=true`, it calls no CRM, enrichment, or sequencer API at all and only processes synthetic `zzz_TEST_` records. The safety guards (loop limits, suppression checks, verification gates) reduce risk; they do not remove it, and they depend on your HubSpot data being complete and current.

Writes are not transactional. If a later step fails, earlier writes in the same run are not rolled back.

## 4. User Responsibility

You are solely responsible for:

- **Legal compliance**, including CAN-SPAM (US), GDPR and UK GDPR, PECR (UK), the ePrivacy Directive (EU), CCPA/CPRA (California), CASL (Canada), and any other law that applies to you or your recipients. This includes having a lawful basis to process the personal data of replacement contacts you did not previously hold, honoring opt-outs and data subject requests, and providing required sender identification and unsubscribe mechanisms.
- **Contracts and platform terms**, including the terms of service, acceptable use policies, data licensing terms, and rate limits of HubSpot, Apollo, Clay, ZeroBounce, Smartlead, Instantly, Slack, n8n, and any other provider you connect. Some providers restrict how their data may be stored, combined, or used for outreach.
- **Credential security**, including storing API keys only as environment variables or in a secret manager, rotating them, and granting the minimum scopes required.
- **Testing**, including running with `SANDBOX_MODE=true` and `DRY_RUN=true` and synthetic `zzz_TEST_` payloads, then reviewing dry-run diffs on real traffic, before connecting any script to production environments, live CRM data, live campaigns, or live notification channels.
- **Ongoing monitoring** of every run, the Slack audit channel, and the n8n execution log.

## 5. Third-Party Services and Trademarks

This project is not affiliated with, endorsed by, or sponsored by HubSpot, Apollo.io, Clay, ZeroBounce, Smartlead, Instantly, Slack, or n8n. Product names are trademarks of their respective owners and are used only to describe compatibility. Third-party APIs change without notice; endpoints, payload fields, scopes, and rate limits described here may be out of date. Verify each integration against the provider's current documentation before use.

## 6. Not Legal Advice

Nothing in this repository is legal, compliance, or financial advice. Consult a qualified professional about your specific obligations.

---

Full license text: [LICENSE](./LICENSE) · MIT © 2026 dhRobin Systems · Provided as-is.
