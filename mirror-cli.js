#!/usr/bin/env node
/*
 * mirror-cli.js
 * Deterministic local mirror of the n8n workflow logic in workflow.json.
 *
 * Zero dependencies. Node 18+ (uses native fetch for the `send` command only).
 *
 * The block between the `// <core` and `// </core>` markers is copied byte for byte
 * into every Code node of workflow.json by scripts/build-workflow.js. Run
 * `node mirror-cli.js parity` to confirm the workflow and this file still match.
 *
 * Commands:
 *   node mirror-cli.js test                         Run the built-in unit tests (offline)
 *   node mirror-cli.js simulate <payload.json>      Run the full pipeline offline, print the dry-run diff
 *        [--hubspot <state.json>]                   Use a synthetic HubSpot state fixture
 *        [--apollo <people.json>]                   Use a synthetic Apollo people fixture
 *        [--json]                                   Print the full result object as JSON
 *   node mirror-cli.js parity                       Check workflow.json Code nodes embed this exact core
 *   node mirror-cli.js send <payload.json>          POST a synthetic payload to your n8n test webhook
 *        [--allow-real]                             Allow a payload that is not a zzz_TEST_ record (not advised)
 *
 * MIT (c) 2026 dhRobin Systems. Provided as-is, see DISCLAIMER.md.
 */
'use strict';

// <core version="1.0.0">
const CORE_VERSION = '1.0.0';

const RFC2606_EXACT = ['example.com', 'example.net', 'example.org'];
const RFC2606_SUFFIXES = ['.example', '.test', '.invalid', '.localhost', '.example.com', '.example.net', '.example.org'];
const DEFAULT_FREE_MAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'zoho.com', 'mail.com'];

const HARD_PATTERNS = /(user unknown|unknown user|no such user|user not found|does not exist|doesn't exist|mailbox not found|mailbox unavailable|no mailbox|address rejected|recipient rejected|invalid recipient|invalid address|address not found|unrouteable|unroutable|account disabled|account has been disabled|account is disabled|not a valid recipient|recipient not found|undeliverable address)/;
const POLICY_PATTERNS = /(spam|blocked|blacklist|blocklist|block list|policy|reputation|dmarc|spf|dkim|rate limit|too many|content rejected|message rejected)/;
const SOFT_PATTERNS = /(mailbox full|quota|temporar|try again|greylist|graylist|deferred|timeout|timed out|connection refused|insufficient storage)/;

const SENIORITY_TIERS = { intern: 0, entry: 1, senior: 2, manager: 3, head: 4, director: 5, vp: 6, partner: 7, c_suite: 7, founder: 8, owner: 8 };

const DEPARTMENTS = [
  { key: 'revops', label: 'Revenue Operations', keywords: ['revenue operations', 'revops', 'rev ops', 'sales operations', 'sales ops', 'marketing operations', 'marketing ops', 'gtm operations', 'go to market operations', 'business systems', 'crm'] },
  { key: 'customer_success', label: 'Customer Success', keywords: ['customer success', 'customer experience', 'client success', 'account management', 'client services', 'customer support', 'support'] },
  { key: 'sales', label: 'Sales', keywords: ['sales', 'account executive', 'business development', 'bdr', 'sdr', 'commercial', 'partnerships', 'revenue', 'cro'] },
  { key: 'marketing', label: 'Marketing', keywords: ['marketing', 'demand generation', 'demand gen', 'growth', 'brand', 'content', 'communications', 'cmo'] },
  { key: 'finance', label: 'Finance', keywords: ['finance', 'financial', 'cfo', 'accounting', 'accountant', 'controller', 'fp&a', 'treasury'] },
  { key: 'hr', label: 'People', keywords: ['human resources', 'hr', 'people', 'talent', 'recruiting', 'recruiter', 'chro'] },
  { key: 'it', label: 'IT', keywords: ['information technology', 'it', 'infrastructure', 'systems administrator', 'sysadmin', 'cio', 'security', 'ciso'] },
  { key: 'engineering', label: 'Engineering', keywords: ['engineering', 'engineer', 'developer', 'software', 'cto', 'devops', 'platform'] },
  { key: 'product', label: 'Product', keywords: ['product', 'cpo'] },
  { key: 'operations', label: 'Operations', keywords: ['operations', 'coo', 'supply chain', 'logistics', 'procurement'] }
];

const STOP_TOKENS = ['of', 'and', 'the', '&', 'for', 'to', 'senior', 'sr', 'junior', 'jr', 'lead', 'head', 'director', 'manager', 'vp', 'svp', 'evp', 'avp', 'vice', 'president', 'chief', 'officer', 'principal', 'staff', 'associate', 'assistant', 'global', 'regional', 'group', 'team', 'intern', 'founder', 'co', 'owner', 'partner', 'executive'];

const HUBSPOT_CONTACT_PROPS = ['email', 'firstname', 'lastname', 'jobtitle', 'lifecyclestage', 'hs_email_optout', 'hs_sales_email_last_replied', 'outbound_last_reply_at', 'outbound_dnc', 'outbound_bounce_status', 'outbound_replacement_of', 'outbound_replaced_by', 'outbound_replacement_generation'];
const HUBSPOT_COMPANY_PROPS = ['name', 'domain', 'lifecyclestage', 'hs_num_open_deals', 'outbound_dnc'];

/* ---------- small helpers ---------- */
function str(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (/^YOUR_[A-Z0-9_]*_HERE$/.test(s)) return ''; // unfilled placeholder counts as unset
  return s;
}
function lower(v) { return str(v).toLowerCase(); }
function toBool(v, dflt) {
  const s = lower(v);
  if (!s) return dflt;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return dflt; // unrecognised value keeps the safe default
}
function toInt(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
function clampInt(v, dflt, min, max) { return Math.min(Math.max(toInt(v, dflt), min), max); }
function toList(v, dflt) { const s = str(v); if (!s) return dflt; return s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); }
function uniq(arr) { return Array.from(new Set(arr)); }
function pick(obj, paths) {
  for (const p of paths) {
    const val = p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
    if (val !== undefined && val !== null && String(val).trim() !== '') return val;
  }
  return undefined;
}
function lowerKeys(o) { const out = {}; for (const k of Object.keys(o || {})) out[k.toLowerCase()] = o[k]; return out; }
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && a.length > 0;
}
function parseTime(v) {
  const s = str(v);
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) return Number(s.length === 10 ? s + '000' : s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function normalizeDomain(s) {
  let d = lower(s);
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split(':')[0];
  return d.replace(/^www\./, '');
}
function emailDomain(email) { const e = lower(email); const at = e.lastIndexOf('@'); return at > 0 ? normalizeDomain(e.slice(at + 1)) : ''; }
function domainsMatch(a, b) { a = normalizeDomain(a); b = normalizeDomain(b); return !!a && !!b && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a)); }
function maskEmail(e) { const s = lower(e); const at = s.indexOf('@'); return at > 1 ? s[0] + '***' + s.slice(at) : s; }

/* ---------- config ---------- */
function readConfig(env) {
  env = env || {};
  return {
    coreVersion: CORE_VERSION,
    dryRun: toBool(env.DRY_RUN, true),
    sandboxMode: toBool(env.SANDBOX_MODE, true),
    webhookSecret: str(env.WEBHOOK_SHARED_SECRET),
    maxReplacementsPerAccount: clampInt(env.MAX_REPLACEMENTS_PER_ACCOUNT, 2, 0, 5),
    replyLookbackDays: clampInt(env.REPLY_LOOKBACK_DAYS, 30, 1, 365),
    minMatchScore: clampInt(env.MIN_MATCH_SCORE, 60, 1, 100),
    enrichTopN: clampInt(env.APOLLO_ENRICH_TOP_N, 2, 1, 5),
    apolloPerPage: clampInt(env.APOLLO_PER_PAGE, 25, 1, 100),
    blockedLifecycleStages: toList(env.BLOCKED_LIFECYCLE_STAGES, ['opportunity', 'customer', 'evangelist']),
    suppressedDomains: toList(env.SUPPRESSED_DOMAINS, []),
    freeMailDomains: toList(env.FREE_MAIL_DOMAINS, DEFAULT_FREE_MAIL),
    acceptEmailStatuses: toList(env.ACCEPT_EMAIL_STATUSES, ['verified']),
    verifierProvider: lower(env.VERIFIER_PROVIDER) || 'none',
    allowCatchAll: toBool(env.ALLOW_CATCH_ALL, false),
    assumeHardWhenUnspecified: toBool(env.ASSUME_HARD_WHEN_UNSPECIFIED, false),
    clayEnabled: toBool(env.CLAY_ENABLED, false),
    clayWebhookUrl: str(env.CLAY_WEBHOOK_URL),
    clayCallbackSecret: str(env.CLAY_CALLBACK_SECRET),
    replacementCampaignId: str(env.REPLACEMENT_CAMPAIGN_ID),
    slackWebhookUrl: str(env.SLACK_WEBHOOK_URL),
    slackNotifyIgnored: toBool(env.SLACK_NOTIFY_IGNORED, false),
    slackRedactEmails: toBool(env.SLACK_REDACT_EMAILS, false),
    testPrefix: 'zzz_TEST_'
  };
}
function isLive(cfg) { return !cfg.dryRun && !cfg.sandboxMode; }
function modeLabel(cfg) {
  if (cfg.sandboxMode) return cfg.dryRun ? 'SANDBOX+DRY_RUN' : 'SANDBOX (writes blocked)';
  return cfg.dryRun ? 'DRY_RUN' : 'LIVE';
}

/* ---------- synthetic data guards ---------- */
function isSyntheticDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return false;
  return RFC2606_EXACT.includes(d) || RFC2606_SUFFIXES.some(s => d.endsWith(s));
}
function isSyntheticRecord(b) {
  if (!b) return false;
  const email = lower(b.email);
  const local = email.split('@')[0] || '';
  return isSyntheticDomain(emailDomain(email)) && (local.startsWith('zzz_test_') || String(b.first_name || '').startsWith('zzz_TEST_'));
}

/* ---------- intake ---------- */
function checkWebhookToken(provided, cfg) {
  if (!cfg.webhookSecret) {
    return cfg.sandboxMode ? { ok: true, warning: 'webhook_secret_not_set_sandbox_only' } : { ok: false, reason: 'webhook_secret_not_set' };
  }
  return safeEqual(provided, cfg.webhookSecret) ? { ok: true } : { ok: false, reason: 'webhook_token_mismatch' };
}
function detectProvider(body, query) {
  const q = lower(query && query.provider);
  if (q === 'smartlead' || q === 'instantly') return q;
  body = body || {};
  if ('lead_email' in body || 'workspace' in body || /^[a-z_]+$/.test(String(body.event_type || '')) && /bounce/.test(String(body.event_type || ''))) return 'instantly';
  if ('sl_email_lead_id' in body || 'sl_lead_email' in body || 'to_email' in body || /^[A-Z_]+$/.test(String(body.event_type || ''))) return 'smartlead';
  return 'unknown';
}
function normalizeBounce(provider, body) {
  body = body || {};
  const bounce = {
    type: str(pick(body, ['bounce_type', 'bounce.type', 'bounce_category', 'bounce.category'])),
    smtp_code: str(pick(body, ['bounce_code', 'smtp_code', 'bounce.smtp_code', 'bounce.code', 'reply_code'])),
    message: str(pick(body, ['bounce_reason', 'bounce_message', 'bounce.reason', 'bounce.message', 'reason', 'smtp_response']))
  };
  let b;
  if (provider === 'smartlead') {
    const toName = str(pick(body, ['to_name', 'lead_data.name']));
    b = {
      email: lower(pick(body, ['to_email', 'sl_lead_email', 'lead_email', 'lead.email', 'lead_data.email'])),
      first_name: str(pick(body, ['lead_data.first_name', 'lead.first_name', 'first_name'])) || toName.split(' ')[0] || '',
      last_name: str(pick(body, ['lead_data.last_name', 'lead.last_name', 'last_name'])) || toName.split(' ').slice(1).join(' ') || '',
      company_name: str(pick(body, ['lead_data.company_name', 'lead.company_name', 'company_name'])),
      title: str(pick(body, ['lead_data.custom_fields.job_title', 'lead_data.custom_fields.title', 'lead_data.job_title', 'lead_data.title', 'lead.title', 'job_title', 'title'])),
      campaign_id: str(pick(body, ['campaign_id', 'campaign.id'])),
      campaign_name: str(pick(body, ['campaign_name', 'campaign.name'])),
      lead_id: str(pick(body, ['sl_email_lead_id', 'lead_id', 'lead.id', 'lead_data.id'])),
      event_type: str(pick(body, ['event_type', 'event']))
    };
  } else {
    b = {
      email: lower(pick(body, ['lead_email', 'email', 'lead.email'])),
      first_name: str(pick(body, ['firstName', 'first_name', 'lead.first_name'])),
      last_name: str(pick(body, ['lastName', 'last_name', 'lead.last_name'])),
      company_name: str(pick(body, ['companyName', 'company_name', 'lead.company_name'])),
      title: str(pick(body, ['jobTitle', 'job_title', 'title', 'lead.job_title', 'payload.jobTitle'])),
      campaign_id: str(pick(body, ['campaign_id', 'campaign'])),
      campaign_name: str(pick(body, ['campaign_name'])),
      lead_id: str(pick(body, ['lead_id', 'lead.id'])),
      event_type: str(pick(body, ['event_type', 'event']))
    };
  }
  b.provider = provider;
  b.domain = emailDomain(b.email);
  b.bounce = bounce;
  return b;
}
function isBounceEvent(provider, eventType) { return /bounce/i.test(String(eventType || '')); }

function classifyBounce(b, cfg) {
  const type = lower(b.bounce && b.bounce.type);
  const code = lower(b.bounce && b.bounce.smtp_code);
  const msg = lower(b.bounce && b.bounce.message);
  const text = code + ' ' + msg;
  const basic = (text.match(/\b([245])\d\d\b/) || [])[1];
  const enhanced = (text.match(/\b([245])\.\d{1,3}\.\d{1,3}\b/) || [])[1];
  if (/(soft|transient|temporary)/.test(type)) return { class: 'soft', reason: 'provider_marked_soft' };
  if (basic === '4' || enhanced === '4') return { class: 'soft', reason: 'smtp_4xx_transient' };
  if (/\b5\.7\.\d{1,3}\b/.test(text) || POLICY_PATTERNS.test(msg)) return { class: 'policy', reason: 'policy_or_reputation_block' };
  if (/(hard|permanent)/.test(type)) return { class: 'hard', reason: 'provider_marked_hard' };
  if (/\b5\.1\.\d{1,3}\b/.test(text)) return { class: 'hard', reason: 'smtp_5_1_x_bad_mailbox' };
  if (HARD_PATTERNS.test(msg)) return { class: 'hard', reason: 'bad_mailbox_message' };
  if (SOFT_PATTERNS.test(msg)) return { class: 'soft', reason: 'transient_message' };
  if (!type && !code && !msg) {
    return cfg.assumeHardWhenUnspecified ? { class: 'hard', reason: 'assumed_hard_no_detail' } : { class: 'unknown', reason: 'no_bounce_detail' };
  }
  return { class: 'unknown', reason: 'unrecognised_bounce_detail' };
}

function intakeBounce(body, query, headers, cfg) {
  query = query || {}; headers = lowerKeys(headers);
  const ignore = (reason, extra) => Object.assign({ route: 'ignore', route_index: 1, reason, mode: modeLabel(cfg), received_at: new Date().toISOString() }, extra || {});
  const auth = checkWebhookToken(query.token || headers['x-webhook-token'], cfg);
  if (!auth.ok) return ignore(auth.reason);
  const warnings = auth.warning ? [auth.warning] : [];
  const provider = detectProvider(body, query);
  if (provider === 'unknown') return ignore('unknown_provider', { warnings });
  const bounced = normalizeBounce(provider, body);
  if (!isBounceEvent(provider, bounced.event_type)) return ignore('not_a_bounce_event', { bounced, warnings });
  if (!bounced.email || !bounced.domain) return ignore('missing_email', { bounced, warnings });
  const synthetic = isSyntheticRecord(bounced);
  if (cfg.sandboxMode && !synthetic) return ignore('sandbox_rejects_non_synthetic_record', { bounced: { provider, domain: bounced.domain }, warnings });
  if (cfg.freeMailDomains.includes(bounced.domain)) return ignore('free_mail_domain_no_company_peer', { bounced, warnings });
  const classification = classifyBounce(bounced, cfg);
  if (classification.class !== 'hard') return ignore('bounce_class_' + classification.class, { bounced, classification, warnings });
  if (!bounced.campaign_id) return ignore('missing_campaign_id', { bounced, classification, warnings });
  if (provider === 'smartlead' && !bounced.lead_id) return ignore('missing_smartlead_lead_id', { bounced, classification, warnings });
  return { route: 'process', route_index: 0, reason: 'hard_bounce_accepted', mode: modeLabel(cfg), bounced, classification, synthetic, source: 'apollo', warnings, received_at: new Date().toISOString() };
}

function validateClayCallback(body, headers, cfg) {
  headers = lowerKeys(headers);
  const reject = (reason) => ({ valid: false, audit_status: 'clay_callback_rejected', audit_detail: reason });
  if (!cfg.clayCallbackSecret) return reject('clay_callback_secret_not_set');
  if (!safeEqual(headers['x-callback-token'], cfg.clayCallbackSecret)) return reject('clay_callback_token_mismatch');
  const ctx = body && body.context;
  const raw = ctx && ctx.bounced;
  if (!raw || !raw.email) return reject('clay_callback_missing_context');
  const bounced = Object.assign({}, raw, { email: lower(raw.email), domain: emailDomain(raw.email) });
  if (cfg.sandboxMode && !isSyntheticRecord(bounced)) return reject('sandbox_rejects_non_synthetic_record');
  const p = (body && (body.candidate || body.person)) || {};
  const email = lower(p.email || p.work_email);
  if (!email) return reject('clay_callback_no_email');
  return {
    valid: true,
    route: 'process',
    reason: 'clay_candidate_received',
    mode: modeLabel(cfg),
    bounced,
    classification: (ctx && ctx.classification) || { class: 'hard', reason: 'from_clay_context' },
    synthetic: isSyntheticRecord(bounced),
    source: 'clay',
    clay_candidate: {
      id: 'clay:' + email,
      first_name: str(p.first_name),
      last_name: str(p.last_name),
      title: str(p.title || p.job_title),
      email,
      email_status: lower(p.email_status || p.verification_status) || 'unverified',
      organization: { primary_domain: normalizeDomain(p.domain) || emailDomain(email) },
      source: 'clay'
    },
    warnings: [],
    received_at: new Date().toISOString()
  };
}

/* ---------- HubSpot state ---------- */
function buildHubSpotSearchBodies(domain) {
  return {
    contacts: { filterGroups: [{ filters: [{ propertyName: 'hs_email_domain', operator: 'EQ', value: domain }] }], properties: HUBSPOT_CONTACT_PROPS, limit: 100 },
    companies: { filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }], properties: HUBSPOT_COMPANY_PROPS, limit: 10 }
  };
}
function buildContextHub(j, cfg) {
  return Object.assign({}, j, { mode: modeLabel(cfg), use_synthetic_reads: cfg.sandboxMode, hubspot_search: buildHubSpotSearchBodies(j.bounced.domain) });
}
function syntheticHubSpotState() { return { source: 'sandbox', contacts: [], companies: [], contacts_total: 0, truncated: false }; }
function assembleHubSpotState(contactsResp, companyResp) {
  const ok = (r) => r && Array.isArray(r.results);
  if (!ok(contactsResp) || !ok(companyResp)) return null;
  const total = Number(contactsResp.total || contactsResp.results.length);
  return { source: 'hubspot', contacts: contactsResp.results, companies: companyResp.results, contacts_total: total, truncated: total > contactsResp.results.length };
}

/* ---------- suppression and loop gate ---------- */
function props(r) { return (r && r.properties) || {}; }
function evaluateAccountGate(bounced, hubspot, cfg, now) {
  const reasons = [];
  const contacts = (hubspot && hubspot.contacts) || [];
  const companies = (hubspot && hubspot.companies) || [];
  if (!hubspot) reasons.push('hubspot_state_unavailable');
  if (hubspot && hubspot.truncated) reasons.push('hubspot_contacts_truncated_review_manually');
  if (cfg.suppressedDomains.some(d => domainsMatch(bounced.domain, d))) reasons.push('domain_on_suppression_list');
  const bouncedRec = contacts.find(c => lower(props(c).email) === bounced.email) || null;
  if (bouncedRec && /quarantined/.test(lower(props(bouncedRec).outbound_bounce_status))) reasons.push('already_processed');
  const replacementCount = contacts.filter(c => str(props(c).outbound_replacement_of)).length;
  if (replacementCount >= cfg.maxReplacementsPerAccount) reasons.push('max_replacements_reached');
  const generation = toInt(bouncedRec && props(bouncedRec).outbound_replacement_generation, 0);
  if (generation >= cfg.maxReplacementsPerAccount) reasons.push('replacement_chain_limit');
  for (const co of companies) {
    const p = props(co);
    const stage = lower(p.lifecyclestage);
    if (stage && cfg.blockedLifecycleStages.includes(stage)) reasons.push('company_stage_' + stage);
    if (toInt(p.hs_num_open_deals, 0) > 0) reasons.push('open_opportunity');
    if (toBool(p.outbound_dnc, false)) reasons.push('company_dnc');
  }
  const cutoff = now - cfg.replyLookbackDays * 86400000;
  for (const c of contacts) {
    const p = props(c);
    const stage = lower(p.lifecyclestage);
    if (stage && cfg.blockedLifecycleStages.includes(stage)) reasons.push('contact_stage_' + stage);
    for (const k of ['hs_sales_email_last_replied', 'outbound_last_reply_at']) {
      const t = parseTime(p[k]);
      if (t && t >= cutoff) reasons.push('active_reply');
    }
  }
  const r = uniq(reasons);
  return {
    passed: r.length === 0,
    reasons: r,
    replacement_count: replacementCount,
    max_replacements: cfg.maxReplacementsPerAccount,
    next_generation: generation + 1,
    bounced_record_id: bouncedRec ? String(bouncedRec.id) : null,
    bounced_record_title: bouncedRec ? (props(bouncedRec).jobtitle || null) : null
  };
}
function buildGateStep(ctx, hubspot, cfg, now) {
  const gate = evaluateAccountGate(ctx.bounced, hubspot, cfg, now);
  return Object.assign({}, ctx, { hubspot, gate, gate_passed: gate.passed });
}

/* ---------- persona ---------- */
function normalizeTitle(t) { return lower(t).replace(/[^a-z0-9&]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function titleTokens(normalized) { return uniq(String(normalized || '').split(' ').filter(t => t.length > 1 && !STOP_TOKENS.includes(t))); }
function normalizeSeniorityKey(s) {
  const k = lower(s).replace(/[\s-]+/g, '_');
  if (k === 'csuite' || k === 'c_level' || k === 'clevel') return 'c_suite';
  return Object.prototype.hasOwnProperty.call(SENIORITY_TIERS, k) ? k : null;
}
function tierOf(key) { return Object.prototype.hasOwnProperty.call(SENIORITY_TIERS, key) ? SENIORITY_TIERS[key] : 1; }
function inferSeniority(title) {
  const n = normalizeTitle(title);
  if (!n) return null;
  const t = ' ' + n + ' ';
  if (/ (co founder|cofounder|founder) /.test(t)) return 'founder';
  if (/ owner /.test(t)) return 'owner';
  if (/ (chief|ceo|cfo|cto|coo|cmo|cro|cio|ciso|cpo|chro) /.test(t)) return 'c_suite';
  if (/ (vp|svp|evp|avp|vice president) /.test(t)) return 'vp';
  if (/ head /.test(t)) return 'head';
  if (/ director /.test(t)) return 'director';
  if (/ (manager|lead|supervisor) /.test(t)) return 'manager';
  if (/ partner /.test(t)) return 'partner';
  if (/ (senior|sr|principal|staff) /.test(t)) return 'senior';
  if (/ (intern|internship|trainee) /.test(t)) return 'intern';
  return 'entry';
}
function extractPersona(title) {
  const normalized = normalizeTitle(title);
  const padded = ' ' + normalized + ' ';
  let dept = null; let matched = [];
  for (const d of DEPARTMENTS) {
    const hits = d.keywords.filter(k => padded.includes(' ' + k + ' '));
    if (hits.length) { dept = d; matched = hits; break; }
  }
  const seniority = normalized ? inferSeniority(normalized) : null;
  return {
    title: str(title),
    normalized,
    department: dept ? dept.key : null,
    department_label: dept ? dept.label : null,
    matched_keywords: matched,
    seniority,
    tier: seniority ? tierOf(seniority) : null,
    tokens: titleTokens(normalized)
  };
}
function targetSeniorities(persona) {
  if (persona.tier === null || persona.tier === undefined) return ['manager', 'head', 'director', 'vp'];
  return Object.keys(SENIORITY_TIERS).filter(k => Math.abs(SENIORITY_TIERS[k] - persona.tier) <= 1 && (SENIORITY_TIERS[k] >= 1 || persona.tier === 0));
}
function buildApolloSearchBody(domain, persona, cfg) {
  const label = persona.department_label;
  const hints = label ? [label, label + ' Manager', 'Director of ' + label, 'Head of ' + label, 'VP ' + label] : [];
  return {
    q_organization_domains_list: [domain],
    person_titles: uniq([persona.title].concat(hints).filter(Boolean)).slice(0, 10),
    include_similar_titles: true,
    person_seniorities: targetSeniorities(persona),
    contact_email_status: ['verified'],
    page: 1,
    per_page: cfg.apolloPerPage
  };
}
function buildPersonaStep(ctx, cfg) {
  const title = ctx.bounced.title || (ctx.gate && ctx.gate.bounced_record_title) || '';
  const persona = extractPersona(title);
  const useSynthetic = cfg.sandboxMode || !!ctx.synthetic;
  let idx;
  if (!persona.department || persona.tier === null) idx = 3;
  else if (ctx.source === 'clay' && ctx.clay_candidate) idx = 2;
  else if (useSynthetic) idx = 1;
  else idx = 0;
  return Object.assign({}, ctx, {
    persona,
    apollo_search: buildApolloSearchBody(ctx.bounced.domain, persona, cfg),
    candidate_source_index: idx,
    candidate_source: ['apollo', 'synthetic', 'clay', 'none'][idx]
  });
}

/* ---------- synthetic candidates (sandbox and zzz_TEST_ records only) ---------- */
function syntheticApolloPeople(bounced, persona) {
  const domain = bounced.domain;
  const label = persona.department_label || 'Operations';
  const tier = persona.tier === null || persona.tier === undefined ? 3 : persona.tier;
  const sameTitle = persona.title || ('Director of ' + label);
  const adjTitle = tier >= 5 ? ('Head of ' + label) : tier === 4 ? (label + ' Director') : ('Senior ' + label + ' Manager');
  const offTitle = persona.department === 'finance' ? 'Software Engineer' : 'Senior Accountant';
  const mk = (id, first, last, title, status) => ({
    id, first_name: first, last_name: last, title,
    email: 'zzz_test_' + first.replace(/^zzz_TEST_/, '').toLowerCase() + '.' + last.toLowerCase() + '@' + domain,
    email_status: status, has_email: true, organization: { primary_domain: domain }, source: 'synthetic'
  });
  return [
    mk('zzz_test_apl_001', 'zzz_TEST_Jordan', 'Pike', sameTitle, 'guessed'),
    mk('zzz_test_apl_002', 'zzz_TEST_Riley', 'Vance', adjTitle, 'verified'),
    mk('zzz_test_apl_003', 'zzz_TEST_Casey', 'Moran', offTitle, 'verified'),
    { id: 'zzz_test_apl_004', first_name: bounced.first_name, last_name: bounced.last_name, title: sameTitle, email: bounced.email, email_status: 'verified', has_email: true, organization: { primary_domain: domain }, source: 'synthetic' }
  ];
}
function clayCandidateAsPeople(ctx) { return { people: ctx.clay_candidate ? [ctx.clay_candidate] : [] }; }

/* ---------- scoring ---------- */
function normalizeApolloPerson(p) {
  p = p || {};
  const org = p.organization || {};
  return {
    id: p.id ? String(p.id) : null,
    first_name: str(p.first_name),
    last_name: str(p.last_name),
    title: str(p.title),
    seniority: normalizeSeniorityKey(p.seniority) || inferSeniority(p.title || ''),
    email: p.email ? lower(p.email) : null,
    email_status: p.email_status ? lower(p.email_status) : null,
    has_email: p.has_email === true || !!p.email,
    organization_domain: normalizeDomain(org.primary_domain || p.organization_domain || org.website_url || ''),
    linkedin_url: p.linkedin_url || null,
    source: p.source || 'apollo'
  };
}
function scoreCandidate(c, persona, bounced) {
  const breakdown = {};
  if (!c.title) return { score: 0, excluded: 'no_title', breakdown, tier_distance: 99 };
  if (c.email && c.email === bounced.email) return { score: 0, excluded: 'same_email_as_bounced', breakdown, tier_distance: 99 };
  const fullName = (a, b) => (lower(a) + ' ' + lower(b)).trim();
  if (c.first_name && c.last_name && !c.last_name.includes('*') && fullName(c.first_name, c.last_name) === fullName(bounced.first_name, bounced.last_name)) {
    return { score: 0, excluded: 'same_person_as_bounced', breakdown, tier_distance: 99 };
  }
  if (c.organization_domain && !domainsMatch(c.organization_domain, bounced.domain)) return { score: 0, excluded: 'different_company_domain', breakdown, tier_distance: 99 };
  const cp = extractPersona(c.title);
  breakdown.department = persona.department && cp.department === persona.department ? 50 : (!persona.department ? 20 : 0);
  const overlap = cp.tokens.filter(t => persona.tokens.includes(t)).length;
  breakdown.title_keywords = Math.min(overlap * 5, 15);
  const cTier = tierOf(c.seniority || cp.seniority);
  const dist = persona.tier === null ? 2 : Math.abs(cTier - persona.tier);
  breakdown.seniority = Math.max(0, 25 - 10 * dist);
  breakdown.email_status = c.email_status === 'verified' ? 10 : 0;
  const score = breakdown.department + breakdown.title_keywords + breakdown.seniority + breakdown.email_status;
  return { score, excluded: null, breakdown, tier_distance: dist };
}
function rankCandidates(people, persona, bounced, cfg) {
  const ranked = []; const rejected = [];
  for (const raw of (people || [])) {
    const c = normalizeApolloPerson(raw);
    const s = scoreCandidate(c, persona, bounced);
    if (s.excluded) { rejected.push({ id: c.id, title: c.title, reason: s.excluded }); continue; }
    if (s.score < cfg.minMatchScore) { rejected.push({ id: c.id, title: c.title, reason: 'score_below_threshold', score: s.score }); continue; }
    ranked.push(Object.assign({}, c, { score: s.score, score_breakdown: s.breakdown, tier_distance: s.tier_distance }));
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.tier_distance - b.tier_distance) || String(a.id).localeCompare(String(b.id)));
  return { ranked, rejected };
}
function buildClayPayload(ctx) {
  const b = ctx.bounced;
  return {
    request_id: [b.provider, b.campaign_id, b.domain, Date.now()].join(':'),
    domain: b.domain,
    company_name: b.company_name || '',
    persona_title: ctx.persona ? ctx.persona.title : '',
    department: ctx.persona ? ctx.persona.department : null,
    target_seniorities: ctx.persona ? targetSeniorities(ctx.persona) : [],
    exclude_email: b.email,
    context: { bounced: b, classification: ctx.classification }
  };
}
function buildScoreStep(ctx, people, cfg) {
  const r = rankCandidates(people, ctx.persona, ctx.bounced, cfg);
  const top = r.ranked.slice(0, cfg.enrichTopN);
  let claySkip = null;
  if (!cfg.clayEnabled) claySkip = 'clay_disabled';
  else if (!cfg.clayWebhookUrl) claySkip = 'clay_webhook_url_not_set';
  else if (cfg.sandboxMode) claySkip = 'sandbox_mode';
  else if (cfg.dryRun) claySkip = 'dry_run_would_dispatch_to_clay';
  else if (ctx.source === 'clay') claySkip = 'already_from_clay';
  else if (ctx.synthetic) claySkip = 'synthetic_record';
  return Object.assign({}, ctx, {
    ranked: top,
    rejected_candidates: r.rejected.slice(0, 15),
    has_candidates: top.length > 0,
    needs_enrichment: top.some(c => !c.email),
    enrich_request: { details: top.filter(c => !c.email).map(c => ({ id: c.id })), reveal_personal_emails: false, reveal_phone_number: false },
    clay_allowed: claySkip === null,
    clay_skip_reason: claySkip,
    clay_payload: claySkip === null ? buildClayPayload(ctx) : null
  });
}

/* ---------- enrichment and verification ---------- */
function mergeEnrichment(ranked, matches) {
  const byId = {};
  for (const m of (matches || [])) if (m && m.id) byId[String(m.id)] = normalizeApolloPerson(m);
  return (ranked || []).map(c => {
    const e = byId[String(c.id)];
    if (!e) return c;
    return Object.assign({}, c, {
      first_name: e.first_name || c.first_name,
      last_name: e.last_name || c.last_name,
      title: e.title || c.title,
      email: e.email || c.email,
      email_status: e.email_status || c.email_status,
      linkedin_url: e.linkedin_url || c.linkedin_url
    });
  });
}
function buildCandidateItems(scoreCtx, matchesResp, cfg) {
  const merged = mergeEnrichment(scoreCtx.ranked, matchesResp && matchesResp.matches).filter(c => c.email);
  const external = cfg.verifierProvider === 'zerobounce' && !cfg.sandboxMode && merged.some(c => !isSyntheticDomain(emailDomain(c.email)));
  if (!merged.length) return [{ _candidate: false, email: null, verify_externally: false }];
  return merged.map(c => Object.assign({}, c, { _candidate: true, verify_externally: external }));
}
function evaluateCandidateSuppression(c, hubspot, bounced, cfg) {
  const reasons = [];
  if (!c || !c.email) return { passed: false, reasons: ['no_email'] };
  const email = lower(c.email);
  if (email === bounced.email) reasons.push('same_as_bounced');
  if (!domainsMatch(emailDomain(email), bounced.domain)) reasons.push('email_domain_mismatch');
  if (cfg.suppressedDomains.some(d => domainsMatch(emailDomain(email), d))) reasons.push('domain_on_suppression_list');
  const rec = ((hubspot && hubspot.contacts) || []).find(r => lower(props(r).email) === email);
  if (rec) {
    const p = props(rec);
    if (toBool(p.hs_email_optout, false)) reasons.push('hubspot_opted_out');
    if (toBool(p.outbound_dnc, false)) reasons.push('hubspot_dnc');
    if (str(p.outbound_bounce_status)) reasons.push('previously_bounced');
    if (str(p.outbound_replacement_of)) reasons.push('already_a_replacement');
    const stage = lower(p.lifecyclestage);
    if (stage && cfg.blockedLifecycleStages.includes(stage)) reasons.push('contact_stage_' + stage);
  }
  return { passed: reasons.length === 0, reasons };
}
function evaluateDeliverability(c, verifier, cfg) {
  if (!c || !c.email) return { deliverable: false, reason: 'no_email' };
  if (!['none', 'zerobounce'].includes(cfg.verifierProvider)) return { deliverable: false, reason: 'unsupported_verifier_' + cfg.verifierProvider };
  const synthetic = isSyntheticDomain(emailDomain(c.email));
  const status = lower(c.email_status);
  const statusOk = cfg.acceptEmailStatuses.includes(status);
  const external = cfg.verifierProvider === 'zerobounce' && !cfg.sandboxMode && !synthetic;
  if (!external) {
    if (!statusOk) return { deliverable: false, reason: 'email_status_' + (status || 'missing') };
    return { deliverable: true, basis: (synthetic ? 'synthetic_' : 'source_') + 'status_' + status };
  }
  if (!statusOk && c.source !== 'clay') return { deliverable: false, reason: 'email_status_' + (status || 'missing') };
  if (!verifier) return { deliverable: false, reason: 'verifier_result_missing' };
  const vs = lower(verifier.status);
  if (vs === 'valid') return { deliverable: true, basis: 'zerobounce_valid' };
  if (vs === 'catch-all' && cfg.allowCatchAll) return { deliverable: true, basis: 'zerobounce_catch_all_allowed' };
  return { deliverable: false, reason: 'zerobounce_' + (vs || 'unknown') };
}
function findVerifierResult(results, email) {
  return (results || []).find(r => r && lower(r.address) === lower(email)) || null;
}
function selectDeliverable(candidates, verifierResults, hubspot, bounced, cfg) {
  const rejections = [];
  for (const c of (candidates || [])) {
    if (!c || !c._candidate) continue;
    const sup = evaluateCandidateSuppression(c, hubspot, bounced, cfg);
    if (!sup.passed) { rejections.push({ id: c.id, reasons: sup.reasons }); continue; }
    const d = evaluateDeliverability(c, findVerifierResult(verifierResults, c.email), cfg);
    if (!d.deliverable) { rejections.push({ id: c.id, reasons: [d.reason] }); continue; }
    return { selected: Object.assign({}, c, { deliverability: d }), rejections };
  }
  return { selected: null, rejections };
}
function buildVerificationStep(scoreCtx, candidates, verifierResults, cfg) {
  const sel = selectDeliverable(candidates, verifierResults, scoreCtx.hubspot, scoreCtx.bounced, cfg);
  return Object.assign({}, scoreCtx, { verification: { rejections: sel.rejections }, deliverable: !!sel.selected, candidate: sel.selected });
}

/* ---------- swap plan and dry-run diff ---------- */
function compact(o) { const out = {}; for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k]; return out; }
function buildSwapPlan(ctx, cfg, nowIso) {
  const b = ctx.bounced; const c = ctx.candidate; const gate = ctx.gate;
  const campaignId = cfg.replacementCampaignId || b.campaign_id;
  const replacementProps = compact({
    email: c.email, firstname: c.first_name, lastname: c.last_name, jobtitle: c.title, company: b.company_name,
    outbound_replacement_of: b.email,
    outbound_replacement_generation: String(gate.next_generation),
    outbound_replacement_source: c.source,
    outbound_replacement_swapped_at: nowIso
  });
  const quarantineProps = compact({
    email: b.email,
    outbound_bounce_status: 'hard_bounced_quarantined',
    outbound_replaced_by: c.email,
    outbound_bounce_reason: ctx.classification && ctx.classification.reason,
    outbound_dnc: 'true'
  });
  const noteText = [
    'Outbound bounced contact replacement',
    'Bounced: ' + b.email + ' (' + (ctx.classification ? ctx.classification.reason : 'hard') + ')',
    'Replacement: ' + c.email + ' | ' + c.title + ' | match score ' + c.score,
    'Source: ' + c.source + ' | deliverability: ' + (c.deliverability ? c.deliverability.basis : 'n/a'),
    'Provider: ' + b.provider + ' | campaign ' + campaignId,
    'Account replacement count after swap: ' + (gate.replacement_count + 1) + ' of ' + gate.max_replacements,
    'Swapped at: ' + nowIso
  ].join('\n');
  const requests = {
    hubspot_upsert: { inputs: [{ idProperty: 'email', id: c.email, properties: replacementProps }, { idProperty: 'email', id: b.email, properties: quarantineProps }] },
    note_text: noteText,
    campaign_id: campaignId,
    bounced_campaign_id: b.campaign_id,
    bounced_lead_id: b.lead_id,
    smartlead_enroll: {
      lead_list: [compact({ first_name: c.first_name, last_name: c.last_name, email: c.email, company_name: b.company_name, custom_fields: { replacement_of: b.email, job_title: c.title } })],
      settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false }
    },
    instantly_enroll: compact({ campaign: campaignId, email: c.email, first_name: c.first_name, last_name: c.last_name, company_name: b.company_name, skip_if_in_workspace: true, custom_variables: { replacement_of: b.email, job_title: c.title } }),
    instantly_blocklist: { bl_value: b.email }
  };
  const plan = [
    { system: 'hubspot', action: 'contact.upsert', target: c.email, detail: replacementProps },
    { system: 'hubspot', action: 'contact.quarantine', target: b.email, detail: quarantineProps },
    { system: 'hubspot', action: 'note.create', target: c.email, detail: { lines: noteText.split('\n').length } },
    { system: b.provider, action: 'lead.enroll', target: c.email, detail: { campaign_id: campaignId } },
    { system: b.provider, action: b.provider === 'smartlead' ? 'lead.unsubscribe_from_campaign' : 'lead.blocklist', target: b.email, detail: b.provider === 'smartlead' ? { campaign_id: b.campaign_id, lead_id: b.lead_id } : { bl_value: b.email } }
  ];
  return Object.assign({}, ctx, { plan, requests, provider_index: b.provider === 'smartlead' ? 0 : 1, live: isLive(cfg), diff: renderDiff(plan, cfg) });
}
function renderDiff(plan, cfg) {
  const head = '=== ' + modeLabel(cfg) + ' swap plan (' + (isLive(cfg) ? 'will write' : 'no writes') + ') ===';
  const lines = plan.map(p => {
    const sign = p.action === 'contact.quarantine' || /unsubscribe|blocklist/.test(p.action) ? '-' : '+';
    return sign + ' [' + p.system + '] ' + p.action + ' ' + p.target + ' ' + JSON.stringify(p.detail);
  });
  return [head].concat(lines).join('\n');
}
function findContactId(upsertResp, email) {
  const r = ((upsertResp && upsertResp.results) || []).find(x => lower(props(x).email) === lower(email));
  return r ? String(r.id) : null;
}
function buildNoteRequest(planCtx, contactId, nowIso) {
  const body = { properties: { hs_timestamp: nowIso, hs_note_body: planCtx.requests.note_text } };
  if (contactId) body.associations = [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }];
  return body;
}

/* ---------- audit ---------- */
function buildSlackMessage(j, cfg, executionId) {
  const status = j.audit_status || (j.error ? 'error' : 'unknown');
  if (status === 'ignored' && !cfg.slackNotifyIgnored) return null;
  const m = (e) => (cfg.slackRedactEmails ? maskEmail(e) : e);
  const b = j.bounced || {};
  const lines = ['[' + modeLabel(cfg) + '] Bounced contact replacement: ' + String(status).toUpperCase()];
  if (b.email) lines.push('Bounced: ' + m(b.email) + ' (' + (b.provider || 'unknown') + ', campaign ' + (b.campaign_id || 'n/a') + ')');
  if (j.candidate && j.candidate.email) lines.push('Replacement: ' + m(j.candidate.email) + ' | ' + j.candidate.title + ' | score ' + j.candidate.score);
  if (j.audit_detail) lines.push(String(j.audit_detail).slice(0, 2500));
  if (j.error) lines.push('Error: ' + String(j.error.message || j.error.description || JSON.stringify(j.error)).slice(0, 800));
  if (executionId) lines.push('n8n execution: ' + executionId);
  return { text: lines.join('\n') };
}
// </core>

/* =====================================================================
 * Everything below runs only in the local CLI. It is not copied into n8n.
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
function envFromDisk() { return Object.assign({}, loadDotEnv(path.join(process.cwd(), '.env')), process.env); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

function extractCore(source) {
  // Markers must start a line, so mentions of them in comments are ignored.
  const startMatch = source.match(/^\/\/ <core version="[^"]+">$/m);
  const endMatch = source.match(/^\/\/ <\/core>$/m);
  if (!startMatch || !endMatch || endMatch.index < startMatch.index) throw new Error('core markers not found');
  const core = source.slice(startMatch.index, endMatch.index + endMatch[0].length);
  if (!core.includes('function readConfig(')) throw new Error('extracted core looks incomplete');
  return core;
}
function coreHash(core) { return crypto.createHash('sha256').update(core).digest('hex').slice(0, 16); }

/**
 * Offline pipeline. Mirrors the n8n node order exactly:
 * intake -> context hub -> HubSpot state -> gate -> persona -> candidates -> score
 * -> enrichment merge -> suppression + verification -> swap plan -> diff.
 */
function runPipeline(webhook, cfg, fixtures, now) {
  fixtures = fixtures || {};
  now = now || Date.now();
  const nowIso = new Date(now).toISOString();
  const trace = [];
  const intake = intakeBounce(webhook.body, webhook.query, webhook.headers, cfg);
  trace.push('intake:' + intake.route + ':' + intake.reason);
  if (intake.route !== 'process') return { status: 'ignored', detail: intake.reason, trace, ctx: intake };

  const hub = buildContextHub(intake, cfg);
  let hubspot;
  if (hub.use_synthetic_reads) hubspot = fixtures.hubspot ? Object.assign({ truncated: false }, fixtures.hubspot) : syntheticHubSpotState();
  else if (fixtures.hubspot) hubspot = Object.assign({ source: 'fixture', truncated: false }, fixtures.hubspot);
  else return { status: 'error', detail: 'live HubSpot reads are not available offline; pass --hubspot <fixture.json>', trace, ctx: hub };
  trace.push('hubspot:' + hubspot.source);

  const gated = buildGateStep(hub, hubspot, cfg, now);
  trace.push('gate:' + (gated.gate_passed ? 'passed' : 'blocked:' + gated.gate.reasons.join('|')));
  if (!gated.gate_passed) return { status: 'blocked', detail: gated.gate.reasons.join(', '), trace, ctx: gated };

  const personaCtx = buildPersonaStep(gated, cfg);
  trace.push('persona:' + personaCtx.persona.department + '/' + personaCtx.persona.seniority + ' source:' + personaCtx.candidate_source);
  if (personaCtx.candidate_source_index === 3) return { status: 'no_persona', detail: 'title missing or unmapped', trace, ctx: personaCtx };

  let people;
  if (personaCtx.candidate_source_index === 1) people = syntheticApolloPeople(personaCtx.bounced, personaCtx.persona);
  else if (personaCtx.candidate_source_index === 2) people = clayCandidateAsPeople(personaCtx).people;
  else if (fixtures.apollo) people = fixtures.apollo.people || [];
  else return { status: 'error', detail: 'live Apollo search is not available offline; pass --apollo <fixture.json>', trace, ctx: personaCtx };

  const scored = buildScoreStep(personaCtx, people, cfg);
  trace.push('score:ranked=' + scored.ranked.length + ' rejected=' + scored.rejected_candidates.length);
  if (!scored.has_candidates) return { status: scored.clay_allowed ? 'clay_dispatched' : 'no_candidate', detail: scored.clay_skip_reason || 'sent to Clay', trace, ctx: scored };

  const matches = scored.needs_enrichment ? { matches: (fixtures.apollo && fixtures.apollo.matches) || [] } : null;
  const items = buildCandidateItems(scored, matches, cfg);
  const verifierResults = items[0].verify_externally ? (fixtures.verifier || []) : [];
  const verified = buildVerificationStep(scored, items, verifierResults, cfg);
  trace.push('verify:' + (verified.deliverable ? 'selected:' + verified.candidate.id : 'none') + ' rejections=' + JSON.stringify(verified.verification.rejections));
  if (!verified.deliverable) return { status: 'candidate_rejected', detail: JSON.stringify(verified.verification.rejections), trace, ctx: verified };

  const planCtx = buildSwapPlan(verified, cfg, nowIso);
  trace.push('plan:' + planCtx.plan.length + ' actions live=' + planCtx.live);
  return { status: planCtx.live ? 'live_ready' : 'dry_run', detail: planCtx.diff, trace, ctx: planCtx };
}

/* ---------- tests ---------- */
function runTests() {
  const results = [];
  const t = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); } };
  const sandboxCfg = readConfig({});
  const liveCfg = readConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false', WEBHOOK_SHARED_SECRET: 'zzz_test_secret' });
  const dir = __dirname;
  const sl = readJson(path.join(dir, 'sample-payloads/smartlead-hard-bounce.json'));
  const inst = readJson(path.join(dir, 'sample-payloads/instantly-hard-bounce.json'));
  const wh = (body, extra) => Object.assign({ body, query: {}, headers: {} }, extra || {});
  const NOW = Date.parse('2026-11-26T09:00:00Z');

  t('config defaults are safe (DRY_RUN and SANDBOX_MODE true)', () => { assert.strictEqual(sandboxCfg.dryRun, true); assert.strictEqual(sandboxCfg.sandboxMode, true); });
  t('only an explicit false disables DRY_RUN', () => { assert.strictEqual(readConfig({ DRY_RUN: 'nope' }).dryRun, true); assert.strictEqual(readConfig({ DRY_RUN: 'False' }).dryRun, false); });
  t('max replacements is clamped to 0..5', () => { assert.strictEqual(readConfig({ MAX_REPLACEMENTS_PER_ACCOUNT: '50' }).maxReplacementsPerAccount, 5); });
  t('placeholder values count as unset', () => { assert.strictEqual(readConfig({ WEBHOOK_SHARED_SECRET: 'YOUR_WEBHOOK_SHARED_SECRET_HERE' }).webhookSecret, ''); });

  t('RFC 2606 domains are synthetic', () => { assert.ok(isSyntheticDomain('acme-corp.example')); assert.ok(isSyntheticDomain('example.com')); assert.ok(!isSyntheticDomain('acme-corp.nonreserved-tld')); });
  t('zzz_TEST_ record detection needs prefix and synthetic domain', () => {
    assert.ok(isSyntheticRecord({ email: 'zzz_test_a@example.com' }));
    assert.ok(!isSyntheticRecord({ email: 'a@example.com', first_name: 'Sam' }));
    assert.ok(!isSyntheticRecord({ email: 'zzz_test_a@acme-corp.nonreserved-tld' }));
  });

  t('classifier: 5.1.1 is hard', () => assert.strictEqual(classifyBounce({ bounce: { smtp_code: '550', message: '5.1.1 user unknown' } }, sandboxCfg).class, 'hard'));
  t('classifier: 4xx mailbox unavailable is soft', () => assert.strictEqual(classifyBounce({ bounce: { smtp_code: '450', message: '4.2.1 mailbox unavailable' } }, sandboxCfg).class, 'soft'));
  t('classifier: 5.7.1 spam block is policy', () => assert.strictEqual(classifyBounce({ bounce: { smtp_code: '550', message: '5.7.1 message rejected as spam' } }, sandboxCfg).class, 'policy'));
  t('classifier: mailbox full is soft', () => assert.strictEqual(classifyBounce({ bounce: { message: 'mailbox full' } }, sandboxCfg).class, 'soft'));
  t('classifier: no detail is unknown unless configured', () => {
    assert.strictEqual(classifyBounce({ bounce: {} }, sandboxCfg).class, 'unknown');
    assert.strictEqual(classifyBounce({ bounce: {} }, readConfig({ ASSUME_HARD_WHEN_UNSPECIFIED: 'true' })).class, 'hard');
  });

  t('intake: sandbox rejects non-synthetic records', () => {
    const body = JSON.parse(JSON.stringify(sl)); body.to_email = 'jane@acme-corp.nonreserved-tld';
    assert.strictEqual(intakeBounce(body, {}, {}, sandboxCfg).reason, 'sandbox_rejects_non_synthetic_record');
  });
  t('intake: live mode needs the shared secret', () => {
    assert.strictEqual(intakeBounce(sl, {}, {}, liveCfg).reason, 'webhook_token_mismatch');
    assert.strictEqual(intakeBounce(sl, { token: 'zzz_test_secret' }, {}, liveCfg).route, 'process');
    assert.strictEqual(intakeBounce(sl, {}, {}, readConfig({ SANDBOX_MODE: 'false' })).reason, 'webhook_secret_not_set');
  });
  t('intake: smartlead sample normalizes', () => {
    const r = intakeBounce(sl, {}, {}, sandboxCfg);
    assert.strictEqual(r.route, 'process'); assert.strictEqual(r.bounced.provider, 'smartlead'); assert.strictEqual(r.bounced.domain, 'acme-corp.example');
  });
  t('intake: instantly sample normalizes', () => {
    const r = intakeBounce(inst, {}, {}, sandboxCfg);
    assert.strictEqual(r.route, 'process'); assert.strictEqual(r.bounced.provider, 'instantly');
  });
  t('intake: soft bounce is ignored', () => {
    const body = JSON.parse(JSON.stringify(sl)); body.bounce_code = '452'; body.bounce_reason = '4.2.2 mailbox full';
    assert.strictEqual(intakeBounce(body, {}, {}, sandboxCfg).reason, 'bounce_class_soft');
  });

  t('persona: revops director', () => { const p = extractPersona('Director of Revenue Operations'); assert.strictEqual(p.department, 'revops'); assert.strictEqual(p.seniority, 'director'); });
  t('persona: VP, Sales', () => { const p = extractPersona('VP, Sales'); assert.strictEqual(p.department, 'sales'); assert.strictEqual(p.seniority, 'vp'); });
  t('persona: partner manager is manager tier', () => assert.strictEqual(inferSeniority('Channel Partner Manager'), 'manager'));
  t('persona: target seniorities stay within one tier', () => assert.deepStrictEqual(targetSeniorities(extractPersona('Director of Marketing')), ['head', 'director', 'vp']));

  const bounced = { email: 'zzz_test_morgan.hale@acme-corp.example', domain: 'acme-corp.example', first_name: 'zzz_TEST_Morgan', last_name: 'Hale' };
  const persona = extractPersona('Director of Revenue Operations');
  t('scoring: other department falls below threshold', () => {
    const r = rankCandidates([{ id: 'x', title: 'Senior Accountant', organization: { primary_domain: 'acme-corp.example' } }], persona, bounced, sandboxCfg);
    assert.strictEqual(r.ranked.length, 0); assert.strictEqual(r.rejected[0].reason, 'score_below_threshold');
  });
  t('scoring: other company domain is excluded', () => {
    const r = rankCandidates([{ id: 'x', title: 'Head of Revenue Operations', organization: { primary_domain: 'globex.example' } }], persona, bounced, sandboxCfg);
    assert.strictEqual(r.rejected[0].reason, 'different_company_domain');
  });
  t('scoring: same person is excluded', () => {
    const r = rankCandidates([{ id: 'x', first_name: 'zzz_TEST_Morgan', last_name: 'Hale', title: 'Director of Revenue Operations' }], persona, bounced, sandboxCfg);
    assert.strictEqual(r.rejected[0].reason, 'same_person_as_bounced');
  });
  t('scoring: deterministic order on ties', () => {
    const a = rankCandidates(syntheticApolloPeople(bounced, persona), persona, bounced, sandboxCfg).ranked.map(c => c.id);
    const b = rankCandidates(syntheticApolloPeople(bounced, persona).reverse(), persona, bounced, sandboxCfg).ranked.map(c => c.id);
    assert.deepStrictEqual(a, b); assert.deepStrictEqual(a, ['zzz_test_apl_001', 'zzz_test_apl_002']);
  });

  const C = (email, p) => ({ id: email, properties: Object.assign({ email }, p || {}) });
  const state = (contacts, companies) => ({ source: 'fixture', contacts: contacts || [], companies: companies || [], truncated: false });
  t('gate: clean account passes', () => assert.ok(evaluateAccountGate(bounced, state([C(bounced.email)]), sandboxCfg, NOW).passed));
  t('gate: max replacements per account', () => {
    const g = evaluateAccountGate(bounced, state([C('zzz_test_a@acme-corp.example', { outbound_replacement_of: 'x' }), C('zzz_test_b@acme-corp.example', { outbound_replacement_of: 'y' })]), sandboxCfg, NOW);
    assert.ok(g.reasons.includes('max_replacements_reached'));
  });
  t('gate: replacement chain limit', () => assert.ok(evaluateAccountGate(bounced, state([C(bounced.email, { outbound_replacement_generation: '2' })]), sandboxCfg, NOW).reasons.includes('replacement_chain_limit')));
  t('gate: already processed bounce is idempotent', () => assert.ok(evaluateAccountGate(bounced, state([C(bounced.email, { outbound_bounce_status: 'hard_bounced_quarantined' })]), sandboxCfg, NOW).reasons.includes('already_processed')));
  t('gate: open deal blocks', () => assert.ok(evaluateAccountGate(bounced, state([], [{ id: '1', properties: { hs_num_open_deals: '1' } }]), sandboxCfg, NOW).reasons.includes('open_opportunity')));
  t('gate: customer stage blocks', () => assert.ok(evaluateAccountGate(bounced, state([], [{ id: '1', properties: { lifecyclestage: 'customer' } }]), sandboxCfg, NOW).reasons.includes('company_stage_customer')));
  t('gate: recent reply blocks', () => assert.ok(evaluateAccountGate(bounced, state([C('zzz_test_c@acme-corp.example', { outbound_last_reply_at: '2026-11-20T10:00:00Z' })]), sandboxCfg, NOW).reasons.includes('active_reply')));
  t('gate: old reply does not block', () => assert.ok(evaluateAccountGate(bounced, state([C('zzz_test_c@acme-corp.example', { outbound_last_reply_at: '2026-01-01T10:00:00Z' })]), sandboxCfg, NOW).passed));
  t('gate: truncated HubSpot results fail closed', () => assert.ok(!evaluateAccountGate(bounced, Object.assign(state(), { truncated: true }), sandboxCfg, NOW).passed));
  t('gate: missing HubSpot state fails closed', () => assert.ok(!evaluateAccountGate(bounced, null, sandboxCfg, NOW).passed));

  t('candidate suppression: opted out in HubSpot', () => {
    const r = evaluateCandidateSuppression({ email: 'zzz_test_r@acme-corp.example' }, state([C('zzz_test_r@acme-corp.example', { hs_email_optout: 'true' })]), bounced, sandboxCfg);
    assert.deepStrictEqual(r.reasons, ['hubspot_opted_out']);
  });
  t('deliverability: guessed status rejected', () => assert.strictEqual(evaluateDeliverability({ email: 'a@acme-corp.example', email_status: 'guessed' }, null, sandboxCfg).deliverable, false));
  t('deliverability: zerobounce must be valid in live mode', () => {
    const cfg = readConfig({ SANDBOX_MODE: 'false', VERIFIER_PROVIDER: 'zerobounce' });
    const c = { email: 'pat@acme-corp.nonreserved-tld', email_status: 'verified', source: 'apollo' };
    assert.strictEqual(evaluateDeliverability(c, { address: c.email, status: 'catch-all' }, cfg).deliverable, false);
    assert.strictEqual(evaluateDeliverability(c, { address: c.email, status: 'valid' }, cfg).deliverable, true);
    assert.strictEqual(evaluateDeliverability(c, null, cfg).reason, 'verifier_result_missing');
  });
  t('deliverability: unknown verifier fails closed', () => assert.strictEqual(evaluateDeliverability({ email: 'a@x.example', email_status: 'verified' }, null, readConfig({ VERIFIER_PROVIDER: 'other' })).deliverable, false));

  t('pipeline: smartlead sample produces a dry-run plan with the verified peer', () => {
    const r = runPipeline(wh(sl), sandboxCfg, {}, NOW);
    assert.strictEqual(r.status, 'dry_run'); assert.strictEqual(r.ctx.candidate.id, 'zzz_test_apl_002'); assert.strictEqual(r.ctx.live, false);
    assert.strictEqual(r.ctx.plan.length, 5);
  });
  t('pipeline: instantly sample produces a dry-run plan', () => {
    const r = runPipeline(wh(inst), sandboxCfg, {}, NOW);
    assert.strictEqual(r.status, 'dry_run'); assert.strictEqual(r.ctx.provider_index, 1);
  });
  t('pipeline: blocked fixture stops before Apollo', () => {
    const fx = readJson(path.join(dir, 'sample-payloads/fixtures/hubspot-state-blocked.json'));
    const r = runPipeline(wh(sl), sandboxCfg, { hubspot: fx }, NOW);
    assert.strictEqual(r.status, 'blocked'); assert.ok(r.detail.includes('max_replacements_reached')); assert.ok(r.detail.includes('open_opportunity'));
  });
  t('pipeline: sandbox never marks a plan live even with DRY_RUN=false', () => {
    const r = runPipeline(wh(sl), readConfig({ DRY_RUN: 'false' }), {}, NOW);
    assert.strictEqual(r.ctx.live, false);
  });
  t('pipeline: live mode with Apollo fixture enriches and selects', () => {
    const cfg = readConfig({ SANDBOX_MODE: 'false', WEBHOOK_SHARED_SECRET: 'zzz_test_secret' });
    const apollo = readJson(path.join(dir, 'sample-payloads/fixtures/apollo-people.json'));
    const body = JSON.parse(JSON.stringify(sl));
    body.to_email = 'morgan.hale@acme-corp.example'; body.to_name = 'Morgan Hale'; body.lead_data.first_name = 'Morgan'; body.lead_data.email = 'morgan.hale@acme-corp.example';
    const r = runPipeline(wh(body, { query: { token: 'zzz_test_secret' } }), cfg, { hubspot: { contacts: [], companies: [] }, apollo }, NOW);
    assert.strictEqual(r.status, 'dry_run'); assert.strictEqual(r.ctx.candidate.id, 'zzz_test_apl_102');
  });

  t('parity: workflow.json embeds this exact core', () => { const p = checkParity(); assert.ok(p.ok, p.message); });

  for (const [s, n] of results) console.log((s === 'PASS' ? '  ok   ' : '  FAIL ') + n);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  return failed === 0;
}

function checkParity() {
  const core = extractCore(fs.readFileSync(__filename, 'utf8'));
  const wfPath = path.join(__dirname, 'workflow.json');
  if (!fs.existsSync(wfPath)) return { ok: false, message: 'workflow.json not found' };
  const wf = readJson(wfPath);
  const codeNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.code');
  const bad = codeNodes.filter(n => !String(n.parameters.jsCode || '').includes(core)).map(n => n.name);
  return { ok: bad.length === 0 && codeNodes.length > 0, message: bad.length ? 'out of date Code nodes: ' + bad.join(', ') + ' (run npm run build:workflow)' : codeNodes.length + ' Code nodes match core ' + coreHash(core), codeNodes: codeNodes.length, hash: coreHash(core) };
}

async function sendPayload(file, args) {
  const env = envFromDisk();
  const url = str(env.N8N_BOUNCE_WEBHOOK_URL);
  if (!url) throw new Error('Set N8N_BOUNCE_WEBHOOK_URL in .env (your n8n test webhook URL).');
  const body = readJson(file);
  const provider = detectProvider(body, {});
  const b = normalizeBounce(provider, body);
  if (!isSyntheticRecord(b) && !args.includes('--allow-real')) throw new Error('Refusing to send: payload is not a zzz_TEST_ record on an RFC 2606 domain.');
  const headers = { 'content-type': 'application/json' };
  if (str(env.WEBHOOK_SHARED_SECRET)) headers['x-webhook-token'] = str(env.WEBHOOK_SHARED_SECRET);
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  console.log('POST ' + url.replace(/\?.*$/, '') + ' -> HTTP ' + res.status);
  console.log((await res.text()).slice(0, 2000));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'test') { process.exit(runTests() ? 0 : 1); }
  if (cmd === 'parity') { const p = checkParity(); console.log((p.ok ? 'OK: ' : 'MISMATCH: ') + p.message); process.exit(p.ok ? 0 : 1); }
  if (cmd === 'simulate') {
    const file = args.find(a => !a.startsWith('--') && a !== argValue(args, '--hubspot') && a !== argValue(args, '--apollo'));
    if (!file) throw new Error('usage: node mirror-cli.js simulate <payload.json> [--hubspot state.json] [--apollo people.json] [--json]');
    const cfg = readConfig(envFromDisk());
    const fixtures = {};
    if (argValue(args, '--hubspot')) fixtures.hubspot = readJson(argValue(args, '--hubspot'));
    if (argValue(args, '--apollo')) fixtures.apollo = readJson(argValue(args, '--apollo'));
    const env = envFromDisk();
    const webhook = { body: readJson(file), query: { token: str(env.WEBHOOK_SHARED_SECRET) }, headers: {} };
    const r = runPipeline(webhook, cfg, fixtures);
    if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log('Mode:   ' + modeLabel(cfg));
    console.log('Status: ' + r.status);
    console.log('Trace:\n  ' + r.trace.join('\n  '));
    console.log('\n' + r.detail);
    return;
  }
  if (cmd === 'send') { const file = args.find(a => !a.startsWith('--')); if (!file) throw new Error('usage: node mirror-cli.js send <payload.json>'); await sendPayload(file, args); return; }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n'));
}

module.exports = { CORE_VERSION, readConfig, intakeBounce, runPipeline, extractCore, coreHash, checkParity };

if (require.main === module) {
  main().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
}
