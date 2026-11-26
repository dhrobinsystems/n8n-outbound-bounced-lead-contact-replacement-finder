#!/usr/bin/env node
/*
 * Builds workflow.json from the shared core in mirror-cli.js.
 * Every Code node gets the exact same core block, so the local mirror and n8n
 * can never drift apart silently. Run: npm run build:workflow
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractCore, coreHash, CORE_VERSION } = require('../mirror-cli.js');

const ROOT = path.join(__dirname, '..');
const core = extractCore(fs.readFileSync(path.join(ROOT, 'mirror-cli.js'), 'utf8'));
const HASH = coreHash(core);

// Deterministic ids so rebuilding produces a stable diff.
const uid = (seed) => {
  const h = crypto.createHash('sha1').update('bounce-replacement:' + seed).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-');
};

const nodes = [];
const connections = {};
const add = (n) => { nodes.push(Object.assign({ id: uid(n.name) }, n)); return n.name; };
const link = (from, to, output = 0, input = 0) => {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: input });
};

/* ---------- node factories ---------- */
const code = (name, pos, body) => ({
  name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: {
    jsCode: '// Shared core v' + CORE_VERSION + ' (hash ' + HASH + '). Generated from mirror-cli.js by scripts/build-workflow.js.\n'
      + '// Edit mirror-cli.js and rebuild instead of editing this block by hand.\n'
      + core + '\n\n// ---------- node logic ----------\n' + body.trim() + '\n'
  }
});
const ifBool = (name, pos, expr) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2, position: pos,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [{ id: uid(name + ':cond'), leftValue: '={{ ' + expr + ' }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and'
    },
    options: {}
  }
});
const switchExpr = (name, pos, outputs, expr) => ({
  name, type: 'n8n-nodes-base.switch', typeVersion: 3, position: pos,
  parameters: { mode: 'expression', numberOutputs: outputs, output: '={{ ' + expr + ' }}' }
});
const setAudit = (name, pos, status, detailExpr) => ({
  name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos,
  parameters: {
    mode: 'manual',
    duplicateItem: false,
    assignments: {
      assignments: [
        { id: uid(name + ':status'), name: 'audit_status', value: status, type: 'string' },
        { id: uid(name + ':detail'), name: 'audit_detail', value: '={{ ' + detailExpr + ' }}', type: 'string' }
      ]
    },
    includeOtherFields: true,
    options: {}
  }
});
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };
const http = (name, pos, p, opts = {}) => {
  const params = {
    method: p.method || 'POST',
    url: p.url,
    authentication: 'none',
    sendQuery: !!p.query,
    sendHeaders: !!p.headers,
    sendBody: !!p.body,
    options: Object.assign({ timeout: 20000 }, p.batching ? { batching: { batch: { batchSize: p.batching[0], batchInterval: p.batching[1] } } } : {})
  };
  if (p.query) params.queryParameters = { parameters: p.query.map(([n, v]) => ({ name: n, value: v })) };
  if (p.headers) params.headerParameters = { parameters: p.headers.map(([n, v]) => ({ name: n, value: v })) };
  if (p.body) { params.specifyBody = 'json'; params.jsonBody = p.body; }
  return Object.assign({ name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, parameters: params }, RETRY, { onError: opts.onError || 'continueErrorOutput' });
};
const sticky = (name, pos, w, h, color, content) => ({
  name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos,
  parameters: { content, width: w, height: h, color }
});

const HS_HEADERS = [['Authorization', '=Bearer {{ $env.HUBSPOT_ACCESS_TOKEN }}'], ['Content-Type', 'application/json']];
const APOLLO_HEADERS = [['X-Api-Key', '={{ $env.APOLLO_API_KEY }}'], ['Content-Type', 'application/json'], ['Cache-Control', 'no-cache']];
const PLAN = "$('Build Swap Plan & Diff').first().json";

/* ---------- 1. intake ---------- */
add({ name: 'Bounce Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: uid('webhook:bounce'),
  parameters: { httpMethod: 'POST', path: 'outbound-bounce', responseMode: 'onReceived', options: {} } });
add(code('Normalize & Classify', [240, 300], `
const cfg = readConfig($env);
return $input.all().map(item => {
  const req = item.json || {};
  return { json: intakeBounce(req.body || {}, req.query || {}, req.headers || {}, cfg) };
});`));
add(switchExpr('Route by Classification', [480, 300], 2, '$json.route_index'));
add(setAudit('Audit: Ignored', [720, 60], 'ignored', '$json.reason'));

/* ---------- 1b. Clay callback ---------- */
add({ name: 'Clay Callback Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 760], webhookId: uid('webhook:clay'),
  parameters: { httpMethod: 'POST', path: 'outbound-bounce-clay-callback', responseMode: 'onReceived', options: {} } });
add(code('Validate Clay Callback', [240, 760], `
const cfg = readConfig($env);
return $input.all().map(item => {
  const req = item.json || {};
  return { json: validateClayCallback(req.body || {}, req.headers || {}, cfg) };
});`));
add(ifBool('Clay Callback Valid?', [480, 760], '$json.valid'));
add(setAudit('Audit: Clay Callback Rejected', [720, 940], 'clay_callback_rejected', '$json.audit_detail'));

/* ---------- 2. context and HubSpot reads ---------- */
add(code('Context Hub', [720, 300], `
const cfg = readConfig($env);
return $input.all().map(item => ({ json: buildContextHub(item.json, cfg) }));`));
add(ifBool('Sandbox Mode?', [960, 300], '$json.use_synthetic_reads'));
add(code('Sandbox: Synthetic HubSpot State', [1200, 100], `
const ctx = $input.first().json;
return [{ json: Object.assign({}, ctx, { hubspot: syntheticHubSpotState() }) }];`));
add(http('HubSpot: Search Domain Contacts', [1200, 300], {
  url: 'https://api.hubapi.com/crm/v3/objects/contacts/search', headers: HS_HEADERS,
  body: '={{ JSON.stringify($json.hubspot_search.contacts) }}'
}));
add(http('HubSpot: Search Company', [1200, 500], {
  url: 'https://api.hubapi.com/crm/v3/objects/companies/search', headers: HS_HEADERS,
  body: '={{ JSON.stringify($json.hubspot_search.companies) }}'
}));
add({ name: 'Wait for HubSpot Reads', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [1440, 400],
  parameters: { mode: 'combine', combineBy: 'combineByPosition', options: {} } });
add(code('Assemble HubSpot State', [1680, 400], `
const ctx = $('Context Hub').first().json;
const hubspot = assembleHubSpotState($('HubSpot: Search Domain Contacts').first().json, $('HubSpot: Search Company').first().json);
// Fail closed: a missing or malformed read becomes hubspot=null, which the gate blocks.
return [{ json: Object.assign({}, ctx, { hubspot }) }];`));

/* ---------- 3. suppression gate and persona ---------- */
add(code('Suppression & Loop Gate', [1920, 300], `
const cfg = readConfig($env);
const ctx = $input.first().json;
return [{ json: buildGateStep(ctx, ctx.hubspot, cfg, Date.now()) }];`));
add(ifBool('Gate Passed?', [2160, 300], '$json.gate_passed'));
add(setAudit('Audit: Blocked by Gate', [2400, 540], 'blocked', "'Gate reasons: ' + $json.gate.reasons.join(', ') + ' | replacements on account: ' + $json.gate.replacement_count + '/' + $json.gate.max_replacements"));
add(code('Domain & Persona Extractor', [2400, 300], `
const cfg = readConfig($env);
return [{ json: buildPersonaStep($input.first().json, cfg) }];`));
add(switchExpr('Candidate Source', [2640, 300], 4, '$json.candidate_source_index'));

/* ---------- 4. candidates ---------- */
add(http('Apollo: People API Search', [2880, 100], {
  url: 'https://api.apollo.io/api/v1/mixed_people/api_search', headers: APOLLO_HEADERS,
  body: '={{ JSON.stringify($json.apollo_search) }}', batching: [1, 1200]
}));
add(code('Sandbox: Synthetic Apollo People', [2880, 300], `
const ctx = $input.first().json;
return [{ json: { people: syntheticApolloPeople(ctx.bounced, ctx.persona) } }];`));
add(code('Clay Candidate as People', [2880, 500], `
return [{ json: clayCandidateAsPeople($input.first().json) }];`));
add(setAudit('Audit: No Persona', [2880, 700], 'no_persona', "'Bounced title missing or unmapped: ' + ($json.persona.title || '(empty)')"));
add(code('Score & Rank Candidates', [3120, 300], `
const cfg = readConfig($env);
const ctx = $('Domain & Persona Extractor').first().json;
const people = ($input.first().json || {}).people || [];
return [{ json: buildScoreStep(ctx, people, cfg) }];`));
add(ifBool('Has Ranked Candidates?', [3360, 300], '$json.has_candidates'));
add(ifBool('Clay Fallback Allowed?', [3600, 600], '$json.clay_allowed'));
add(http('Clay: Request Enrichment', [3840, 520], {
  url: '={{ $env.CLAY_WEBHOOK_URL }}',
  headers: [['Content-Type', 'application/json'], ['x-clay-webhook-auth', '={{ $env.CLAY_WEBHOOK_AUTH_TOKEN }}']],
  body: '={{ JSON.stringify($json.clay_payload) }}'
}));
add(setAudit('Audit: Sent to Clay', [4080, 520], 'clay_dispatched', "'No Apollo peer passed scoring. Clay enrichment requested; result returns via the Clay Callback Webhook.'"));
add(setAudit('Audit: No Candidate', [3840, 720], 'no_candidate', "'No peer passed scoring (' + $json.rejected_candidates.length + ' rejected). Clay: ' + $json.clay_skip_reason"));
add(ifBool('Needs Apollo Enrichment?', [3600, 300], '$json.needs_enrichment'));
add(http('Apollo: Bulk People Match', [3840, 160], {
  url: 'https://api.apollo.io/api/v1/people/bulk_match', headers: APOLLO_HEADERS,
  body: '={{ JSON.stringify($json.enrich_request) }}', batching: [1, 1200]
}));
add(code('Normalize Enriched Candidates', [4080, 300], `
const cfg = readConfig($env);
const scoreCtx = $('Score & Rank Candidates').first().json;
const incoming = $input.first().json || {};
return buildCandidateItems(scoreCtx, incoming.matches ? incoming : null, cfg).map(c => ({ json: c }));`));

/* ---------- 5. verification ---------- */
add(ifBool('Verify Externally?', [4320, 300], '$json.verify_externally'));
add(http('ZeroBounce: Validate Email', [4560, 160], {
  method: 'GET', url: 'https://api.zerobounce.net/v2/validate',
  query: [['api_key', '={{ $env.ZEROBOUNCE_API_KEY }}'], ['email', '={{ $json.email }}'], ['ip_address', '']],
  batching: [1, 500]
}));
add(code('Candidate Suppression & Verification Gate', [4800, 300], `
const cfg = readConfig($env);
const scoreCtx = $('Score & Rank Candidates').first().json;
const candidates = $('Normalize Enriched Candidates').all().map(i => i.json);
const verifierResults = $input.all().map(i => i.json).filter(j => j && j.address !== undefined && j.status !== undefined);
return [{ json: buildVerificationStep(scoreCtx, candidates, verifierResults, cfg) }];`));
add(ifBool('Deliverable?', [5040, 300], '$json.deliverable'));
add(setAudit('Audit: Candidates Rejected', [5280, 540], 'candidate_rejected', "'All ranked peers failed suppression or verification: ' + JSON.stringify($json.verification.rejections)"));

/* ---------- 6. plan, dry run gate ---------- */
add(code('Build Swap Plan & Diff', [5280, 300], `
const cfg = readConfig($env);
return [{ json: buildSwapPlan($input.first().json, cfg, new Date().toISOString()) }];`));
add(ifBool('Live Mode?', [5520, 300], '$json.live'));
add(setAudit('Audit: Dry Run Diff', [5760, 540], 'dry_run', '$json.diff'));

/* ---------- 7. live writes ---------- */
add(http('HubSpot: Upsert Replacement + Quarantine Bounced', [5760, 300], {
  url: 'https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', headers: HS_HEADERS,
  body: '={{ JSON.stringify($json.requests.hubspot_upsert) }}'
}));
add(code('Build Note Request', [6000, 300], `
const planCtx = $('Build Swap Plan & Diff').first().json;
const contactId = findContactId($input.first().json, planCtx.candidate.email);
return [{ json: { replacement_contact_id: contactId, note_request: buildNoteRequest(planCtx, contactId, new Date().toISOString()) } }];`));
add(http('HubSpot: Log Swap Note', [6240, 300], {
  url: 'https://api.hubapi.com/crm/v3/objects/notes', headers: HS_HEADERS,
  body: '={{ JSON.stringify($json.note_request) }}'
}));
add(switchExpr('Route by Provider', [6480, 300], 2, PLAN + '.provider_index'));
add(http('Smartlead: Enroll Replacement', [6720, 160], {
  url: '=https://server.smartlead.ai/api/v1/campaigns/{{ ' + PLAN + '.requests.campaign_id }}/leads',
  query: [['api_key', '={{ $env.SMARTLEAD_API_KEY }}']], headers: [['Content-Type', 'application/json']],
  body: '={{ JSON.stringify(' + PLAN + '.requests.smartlead_enroll) }}', batching: [1, 1000]
}));
add(http('Smartlead: Unsubscribe Bounced Lead', [6960, 160], {
  url: '=https://server.smartlead.ai/api/v1/campaigns/{{ ' + PLAN + '.requests.bounced_campaign_id }}/leads/{{ ' + PLAN + '.requests.bounced_lead_id }}/unsubscribe',
  query: [['api_key', '={{ $env.SMARTLEAD_API_KEY }}']], batching: [1, 1000]
}));
add(http('Instantly: Enroll Replacement', [6720, 440], {
  url: 'https://api.instantly.ai/api/v2/leads',
  headers: [['Authorization', '=Bearer {{ $env.INSTANTLY_API_KEY }}'], ['Content-Type', 'application/json']],
  body: '={{ JSON.stringify(' + PLAN + '.requests.instantly_enroll) }}', batching: [1, 1000]
}));
add(http('Instantly: Blocklist Bounced Email', [6960, 440], {
  url: 'https://api.instantly.ai/api/v2/block-lists-entries',
  headers: [['Authorization', '=Bearer {{ $env.INSTANTLY_API_KEY }}'], ['Content-Type', 'application/json']],
  body: '={{ JSON.stringify(' + PLAN + '.requests.instantly_blocklist) }}', batching: [1, 1000]
}));
add(code('Live Run Summary', [7200, 300], `
const planCtx = $('Build Swap Plan & Diff').first().json;
const note = $('Build Note Request').first().json;
return [{ json: Object.assign({}, planCtx, {
  audit_status: 'swapped',
  audit_detail: planCtx.diff.replace('(will write)', '(written)') + '\\nHubSpot replacement contact id: ' + (note.replacement_contact_id || 'not returned') + '\\nProvider response: ' + JSON.stringify($input.first().json).slice(0, 600)
}) }];`));

/* ---------- 8. errors and Slack audit ---------- */
add(code('Build Error Audit', [5760, 1000], `
return $input.all().map(item => {
  const j = item.json || {};
  const err = j.error || j;
  return { json: { audit_status: 'error', audit_detail: 'An HTTP step failed after 3 attempts. The run stopped at that step; check the execution log before re-running. Writes before the failed step are not rolled back.', error: { message: err.message || err.description || 'unknown error', httpCode: err.httpCode || null } } };
});`));
add(code('Build Slack Audit Message', [7440, 760], `
const cfg = readConfig($env);
const out = [];
for (const item of $input.all()) {
  const msg = buildSlackMessage(item.json || {}, cfg, $execution.id);
  if (msg) out.push({ json: { slack_body: msg, slack_configured: !!cfg.slackWebhookUrl } });
}
return out;`));
add(ifBool('Slack Configured?', [7680, 760], '$json.slack_configured'));
add(Object.assign(http('Slack: Post Audit Alert', [7920, 760], {
  url: '={{ $env.SLACK_WEBHOOK_URL }}', headers: [['Content-Type', 'application/json']],
  body: '={{ JSON.stringify($json.slack_body) }}'
}, { onError: 'continueRegularOutput' })));

/* ---------- connections ---------- */
link('Bounce Webhook', 'Normalize & Classify');
link('Normalize & Classify', 'Route by Classification');
link('Route by Classification', 'Context Hub', 0);
link('Route by Classification', 'Audit: Ignored', 1);
link('Clay Callback Webhook', 'Validate Clay Callback');
link('Validate Clay Callback', 'Clay Callback Valid?');
link('Clay Callback Valid?', 'Context Hub', 0);
link('Clay Callback Valid?', 'Audit: Clay Callback Rejected', 1);
link('Context Hub', 'Sandbox Mode?');
link('Sandbox Mode?', 'Sandbox: Synthetic HubSpot State', 0);
link('Sandbox Mode?', 'HubSpot: Search Domain Contacts', 1);
link('Sandbox Mode?', 'HubSpot: Search Company', 1);
link('HubSpot: Search Domain Contacts', 'Wait for HubSpot Reads', 0, 0);
link('HubSpot: Search Company', 'Wait for HubSpot Reads', 0, 1);
link('Wait for HubSpot Reads', 'Assemble HubSpot State');
link('Sandbox: Synthetic HubSpot State', 'Suppression & Loop Gate');
link('Assemble HubSpot State', 'Suppression & Loop Gate');
link('Suppression & Loop Gate', 'Gate Passed?');
link('Gate Passed?', 'Domain & Persona Extractor', 0);
link('Gate Passed?', 'Audit: Blocked by Gate', 1);
link('Domain & Persona Extractor', 'Candidate Source');
link('Candidate Source', 'Apollo: People API Search', 0);
link('Candidate Source', 'Sandbox: Synthetic Apollo People', 1);
link('Candidate Source', 'Clay Candidate as People', 2);
link('Candidate Source', 'Audit: No Persona', 3);
link('Apollo: People API Search', 'Score & Rank Candidates', 0);
link('Sandbox: Synthetic Apollo People', 'Score & Rank Candidates');
link('Clay Candidate as People', 'Score & Rank Candidates');
link('Score & Rank Candidates', 'Has Ranked Candidates?');
link('Has Ranked Candidates?', 'Needs Apollo Enrichment?', 0);
link('Has Ranked Candidates?', 'Clay Fallback Allowed?', 1);
link('Clay Fallback Allowed?', 'Clay: Request Enrichment', 0);
link('Clay Fallback Allowed?', 'Audit: No Candidate', 1);
link('Clay: Request Enrichment', 'Audit: Sent to Clay', 0);
link('Needs Apollo Enrichment?', 'Apollo: Bulk People Match', 0);
link('Needs Apollo Enrichment?', 'Normalize Enriched Candidates', 1);
link('Apollo: Bulk People Match', 'Normalize Enriched Candidates', 0);
link('Normalize Enriched Candidates', 'Verify Externally?');
link('Verify Externally?', 'ZeroBounce: Validate Email', 0);
link('Verify Externally?', 'Candidate Suppression & Verification Gate', 1);
link('ZeroBounce: Validate Email', 'Candidate Suppression & Verification Gate', 0);
link('Candidate Suppression & Verification Gate', 'Deliverable?');
link('Deliverable?', 'Build Swap Plan & Diff', 0);
link('Deliverable?', 'Audit: Candidates Rejected', 1);
link('Build Swap Plan & Diff', 'Live Mode?');
link('Live Mode?', 'HubSpot: Upsert Replacement + Quarantine Bounced', 0);
link('Live Mode?', 'Audit: Dry Run Diff', 1);
link('HubSpot: Upsert Replacement + Quarantine Bounced', 'Build Note Request', 0);
link('Build Note Request', 'HubSpot: Log Swap Note');
link('HubSpot: Log Swap Note', 'Route by Provider', 0);
link('Route by Provider', 'Smartlead: Enroll Replacement', 0);
link('Route by Provider', 'Instantly: Enroll Replacement', 1);
link('Smartlead: Enroll Replacement', 'Smartlead: Unsubscribe Bounced Lead', 0);
link('Smartlead: Unsubscribe Bounced Lead', 'Live Run Summary', 0);
link('Instantly: Enroll Replacement', 'Instantly: Blocklist Bounced Email', 0);
link('Instantly: Blocklist Bounced Email', 'Live Run Summary', 0);

// error outputs (output index 1 on HTTP nodes with continueErrorOutput)
['HubSpot: Search Domain Contacts', 'HubSpot: Search Company', 'Apollo: People API Search', 'Apollo: Bulk People Match',
  'ZeroBounce: Validate Email', 'Clay: Request Enrichment', 'HubSpot: Upsert Replacement + Quarantine Bounced', 'HubSpot: Log Swap Note',
  'Smartlead: Enroll Replacement', 'Smartlead: Unsubscribe Bounced Lead', 'Instantly: Enroll Replacement', 'Instantly: Blocklist Bounced Email'
].forEach(n => link(n, 'Build Error Audit', 1));

['Audit: Ignored', 'Audit: Clay Callback Rejected', 'Audit: Blocked by Gate', 'Audit: No Persona', 'Audit: Sent to Clay', 'Audit: No Candidate',
  'Audit: Candidates Rejected', 'Audit: Dry Run Diff', 'Live Run Summary', 'Build Error Audit'
].forEach(n => link(n, 'Build Slack Audit Message'));
link('Build Slack Audit Message', 'Slack Configured?');
link('Slack Configured?', 'Slack: Post Audit Alert', 0);

/* ---------- sticky notes ---------- */
add(sticky('Note: Overview', [-60, -420], 760, 360, 7,
`## Bounced Contact Replacement Finder
Catches hard bounces from **Smartlead** or **Instantly**, finds a peer with the same persona and seniority at the same domain (Apollo, Clay fallback), verifies the address, logs the swap in **HubSpot**, enrolls the peer and suppresses the bounced contact.

**Safe defaults:** \`DRY_RUN=true\` and \`SANDBOX_MODE=true\`. Sandbox accepts only \`zzz_TEST_\` records on RFC 2606 domains and uses synthetic HubSpot and Apollo data, so no credentials are needed for the first run. Writes happen only when **both** flags are \`false\`.

All Code nodes share one core generated from \`mirror-cli.js\` (core v${CORE_VERSION}, hash \`${HASH}\`). Edit the mirror, run \`npm run build:workflow\`, re-import.`));
add(sticky('Note: Intake', [-60, 0], 760, 280, 5,
`### 1. Intake, auth and hard-bounce classifier
- Checks \`?token=\` or \`x-webhook-token\` against \`WEBHOOK_SHARED_SECRET\` (required outside sandbox).
- Detects provider, normalizes fields, rejects free-mail domains.
- **Hard** = 5.1.x or bad-mailbox text. **Soft** (4xx), **policy** (5.7.x, spam, reputation) and **unknown** are ignored. A policy block means the mailbox may exist, so no swap.`));
add(sticky('Note: Clay Callback', [-60, 620], 760, 420, 6,
`### 1b. Clay fallback callback
Clay is async. When Apollo finds no peer, the workflow posts the request to your Clay table and stops. Your Clay table sends the result back here with header \`x-callback-token: CLAY_CALLBACK_SECRET\`.
The callback re-enters at **Context Hub**, so the full suppression gate runs again on fresh HubSpot state before anything is enrolled.`));
add(sticky('Note: Gate', [1160, -160], 1220, 220, 3,
`### 2. Suppression and loop gate (fails closed)
Blocks when: replacements on the domain >= \`MAX_REPLACEMENTS_PER_ACCOUNT\` (default 2, hard cap 5) | bounced record already quarantined (idempotent replays) | replacement chain generation limit | company or any contact in \`BLOCKED_LIFECYCLE_STAGES\` | open deals | any reply inside \`REPLY_LOOKBACK_DAYS\` | DNC flag | domain on \`SUPPRESSED_DOMAINS\` | HubSpot read failed or truncated (>100 contacts).`));
add(sticky('Note: Candidates', [2600, -160], 1700, 220, 4,
`### 3. Persona extraction, Apollo search, scoring
Title -> department + seniority tier. Apollo People API Search filters the same domain, related titles and seniorities within one tier. Score (0-100): department 50, shared title keywords up to 15, seniority distance 25 / 15 / 5, verified email 10. Threshold \`MIN_MATCH_SCORE\` (60). Top \`APOLLO_ENRICH_TOP_N\` go to Bulk People Match to reveal work emails (this spends Apollo credits). HTTP nodes: 3 tries, 3 s apart, batched 1 request per 1.2 s.`));
add(sticky('Note: Verification', [4280, -160], 980, 220, 4,
`### 4. Candidate suppression and email verification gate
Per ranked peer, in order: same as bounced, domain mismatch, HubSpot opt-out, DNC, earlier bounce, already a replacement, blocked stage. Then deliverability: source status must be in \`ACCEPT_EMAIL_STATUSES\` (default \`verified\`). With \`VERIFIER_PROVIDER=zerobounce\` the result must be \`valid\` (catch-all only with \`ALLOW_CATCH_ALL=true\`). First peer that clears everything wins.`));
add(sticky('Note: Dry Run Gate', [5240, 660], 760, 240, 2,
`### 5. DRY_RUN gate
**Build Swap Plan & Diff** always produces the exact request bodies and a readable diff. **Live Mode?** is true only when \`DRY_RUN=false\` **and** \`SANDBOX_MODE=false\`. Otherwise the diff goes to Slack and nothing is written anywhere.`));
add(sticky('Note: Live Writes', [5720, -160], 1660, 220, 1,
`### 6. Live writes (retry 3x, 3 s backoff, errors routed to alert)
HubSpot batch upsert by email: replacement gets \`outbound_replacement_of\` and generation, bounced contact gets \`outbound_bounce_status=hard_bounced_quarantined\` and \`outbound_dnc=true\`. A note is logged on the replacement. Then Smartlead (add lead to the active campaign with block lists respected, unsubscribe bounced lead) or Instantly (add lead with \`skip_if_in_workspace\`, blocklist bounced email).`));
add(sticky('Note: Errors and Audit', [5720, 900], 2460, 260, 6,
`### 7. Error branch and Slack audit
Every HTTP node uses **continue (error output)** after its retries, so failures land in **Build Error Audit** instead of dying silently. Earlier writes are not rolled back; the alert says so. Every outcome (blocked, no candidate, rejected, dry-run diff, swapped, error) posts one Slack message when \`SLACK_WEBHOOK_URL\` is set. Ignored events post only with \`SLACK_NOTIFY_IGNORED=true\`. The Slack node never fails the run.`));

const workflow = {
  name: 'Outbound Bounced Lead Contact Replacement Finder',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', callerPolicy: 'workflowsFromSameOwner' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false, coreVersion: CORE_VERSION, coreHash: HASH },
  tags: []
};
fs.writeFileSync(path.join(ROOT, 'workflow.json'), JSON.stringify(workflow, null, 2) + '\n');
console.log('workflow.json written: ' + nodes.length + ' nodes, core ' + HASH);
