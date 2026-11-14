// ==UserScript==
// @name         X US-Only Feed Filter
// @namespace    twitter-us-only
// @version      1.0.0
// @description  Hides posts on X/Twitter from accounts not based in the United States, with an optional filter for AI-sounding text.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-idle
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__xUsOnlyLoaded) return;
  window.__xUsOnlyLoaded = true;

  // ---------------------------------------------------------------- settings

  const SETTINGS_KEY = 'xUsOnly.settings.v1';
  const CACHE_KEY = 'xUsOnly.countryCache.v1';

  const DEFAULTS = {
    usOnly: true,
    hideUnverified: true, // hide posts whose author country is unknown / still being checked
    aiFilter: false,
    aiSensitivity: 'medium', // low | medium | high
    allowlist: '', // handles that are never hidden
    queryId: '', // manual override for X's AboutAccountQuery id
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage full or blocked: keep working in memory */
    }
  }

  const settings = Object.assign({}, DEFAULTS, loadJson(SETTINGS_KEY, {}));
  let allowSet = new Set();
  function refreshAllowSet() {
    allowSet = new Set(
      settings.allowlist
        .split(/[\s,]+/)
        .map((h) => h.replace(/^@/, '').toLowerCase())
        .filter(Boolean)
    );
  }
  refreshAllowSet();
  function saveSettings() {
    saveJson(SETTINGS_KEY, settings);
    refreshAllowSet();
  }

  // ------------------------------------------------------ country lookup/cache

  // Cache values: 'US', '?' (X gave no usable country), or the foreign country name.
  const DAY = 24 * 60 * 60 * 1000;
  const TTL_KNOWN = 30 * DAY;
  const TTL_UNKNOWN = 1 * DAY;
  const MAX_CACHE = 5000;

  const cache = new Map(); // handle -> { c: string, t: number }
  (function loadCache() {
    const stored = loadJson(CACHE_KEY, {});
    const now = Date.now();
    for (const handle in stored) {
      const entry = stored[handle];
      if (!entry || typeof entry.c !== 'string') continue;
      const ttl = entry.c === '?' ? TTL_UNKNOWN : TTL_KNOWN;
      if (now - entry.t < ttl) cache.set(handle, entry);
    }
  })();

  let cacheSaveTimer = null;
  function persistCache() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;
      let entries = Array.from(cache.entries());
      if (entries.length > MAX_CACHE) {
        entries.sort((a, b) => b[1].t - a[1].t);
        entries = entries.slice(0, MAX_CACHE);
      }
      const out = {};
      for (const [h, e] of entries) out[h] = e;
      saveJson(CACHE_KEY, out);
    }, 1500);
  }

  // Public bearer token used by the X web client itself (not a secret, same for everyone).
  const BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const DEFAULT_QUERY_ID = 'XRqGa7EeokUU5kppkh13EA';
  let discoveredQueryId = null;
  let discoveryPromise = null;

  const queue = []; // handles waiting for lookup, newest last (served LIFO)
  const queued = new Set();
  const retryAfter = new Map(); // handle -> timestamp, for transient failures
  let active = 0;
  let pausedUntil = 0;
  let lastError = '';
  const MAX_ACTIVE = 2;
  const GAP_MS = 250;

  function classifyCountry(value) {
    if (!value || typeof value !== 'string') return '?';
    const v = value.trim();
    if (/^(united states|usa|u\.s\.a?\.?|us)\b/i.test(v)) return 'US';
    // X lets accounts show only a region ("North America"), which can't confirm the US.
    if (/\b(america|europe|asia|africa|oceania|australasia)\b/i.test(v) && !/south africa/i.test(v)) return '?';
    return v;
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? m[1] : '';
  }

  // Shared promise so concurrent lookups all wait for the same discovery.
  function discoverQueryId() {
    if (!discoveryPromise) discoveryPromise = scanBundlesForQueryId();
    return discoveryPromise;
  }

  async function scanBundlesForQueryId() {
    const srcs = Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.src)
      .filter((s) => /twimg\.com|x\.com/.test(s));
    for (const src of srcs) {
      try {
        const text = await (await fetch(src)).text();
        const m =
          text.match(/queryId:"([\w-]+)",operationName:"AboutAccountQuery"/) ||
          text.match(/operationName:"AboutAccountQuery"[^}]{0,200}queryId:"([\w-]+)"/);
        if (m) {
          discoveredQueryId = m[1];
          break;
        }
      } catch (e) {
        /* try the next bundle */
      }
    }
    return discoveredQueryId;
  }

  async function requestAbout(handle, queryId) {
    const url =
      location.origin +
      '/i/api/graphql/' +
      queryId +
      '/AboutAccountQuery?variables=' +
      encodeURIComponent(JSON.stringify({ screenName: handle }));
    return fetch(url, {
      credentials: 'include',
      headers: {
        authorization: 'Bearer ' + BEARER,
        'x-csrf-token': csrfToken(),
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'content-type': 'application/json',
      },
    });
  }

  function noteRateLimit(res) {
    const remaining = parseInt(res.headers.get('x-rate-limit-remaining'), 10);
    const reset = parseInt(res.headers.get('x-rate-limit-reset'), 10);
    const resetMs = reset ? reset * 1000 + 1000 : Date.now() + 5 * 60 * 1000;
    if (res.status === 429 || remaining === 0) {
      pausedUntil = Math.max(pausedUntil, resetMs);
    }
  }

  async function lookup(handle) {
    let queryId = settings.queryId || discoveredQueryId || DEFAULT_QUERY_ID;
    let res = await requestAbout(handle, queryId);
    if ((res.status === 400 || res.status === 404) && !settings.queryId) {
      // X rotated the query id: try to read the current one from its own scripts.
      const found = await discoverQueryId();
      if (found && found !== queryId) res = await requestAbout(handle, found);
    }
    noteRateLimit(res);
    if (res.status === 429) return null; // retry after the pause
    if (res.status === 401 || res.status === 403) throw new Error('Not signed in to X (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error('X lookup failed (HTTP ' + res.status + ')');
    const json = await res.json();
    const result = json && json.data && json.data.user_result_by_screen_name && json.data.user_result_by_screen_name.result;
    const based = result && result.about_profile && result.about_profile.account_based_in;
    return classifyCountry(based);
  }

  function enqueue(handle) {
    if (queued.has(handle)) return;
    const retry = retryAfter.get(handle);
    if (retry && Date.now() < retry) return;
    queued.add(handle);
    queue.push(handle);
    pump();
  }

  let pumpTimer = null;
  function pump() {
    const now = Date.now();
    if (now < pausedUntil) {
      if (!pumpTimer) {
        pumpTimer = setTimeout(() => {
          pumpTimer = null;
          pump();
        }, Math.min(pausedUntil - now + 50, 60000));
      }
      updateUi();
      return;
    }
    while (active < MAX_ACTIVE && queue.length) {
      const handle = queue.pop();
      active++;
      lookup(handle)
        .then((country) => {
          if (country === null) {
            queued.delete(handle);
            enqueue(handle);
            return;
          }
          lastError = '';
          cache.set(handle, { c: country, t: Date.now() });
          persistCache();
          queued.delete(handle);
        })
        .catch((err) => {
          lastError = String((err && err.message) || err);
          queued.delete(handle);
          retryAfter.set(handle, Date.now() + 5 * 60 * 1000);
        })
        .then(() => {
          active--;
          scheduleScan();
          setTimeout(pump, GAP_MS);
        });
    }
    updateUi();
  }

  // ------------------------------------------------------- AI text heuristic

  const AI_PHRASES = [
    /\bdelv(e|es|ing)\b/i,
    /\btapestry\b/i,
    /\btestament to\b/i,
    /\b(ever[- ]evolving|ever[- ]changing|fast[- ]paced) (landscape|world)\b/i,
    /\bin today'?s (world|digital|fast|landscape|age)\b/i,
    /\b(digital|evolving|competitive) landscape\b/i,
    /\bgame[- ]changer\b/i,
    /\bit'?s (important|worth) (to note|noting)\b/i,
    /\blet'?s (dive|break (it|this) down|unpack)\b/i,
    /\bhere'?s the (thing|kicker|truth|reality)\b/i,
    /\bhere'?s (why|how|what)( (it|this|that) matters)?:/i,
    /\b(let that sink in|read that again)\b/i,
    /\bunlock(s|ing)? (the|your|new|true|full)\b/i,
    /\b(seamless(ly)?|holistic|multifaceted|pivotal|paramount|underscore[sd]?|foster(s|ing)?|leverag(e|es|ing)|harness(es|ing)?)\b/i,
    /\b(moreover|furthermore|additionally|in conclusion|in summary|ultimately),/i,
    /\bnavigat(e|ing) the (complex|world|landscape|challenges)/i,
    /\ba (stark|powerful|gentle) reminder\b/i,
    /\bthe (real|bigger) (question|lesson|takeaway) (is|here)\b/i,
    /\bplays? a (crucial|key|vital|pivotal) role\b/i,
    /\bat (its|the) core\b/i,
  ];
  const AI_CONTRAST = [
    /\b(it'?s|this is|that'?s|they'?re|we'?re) not (just |only |merely |about )?[^.!?\n]{2,60}[.,;—–-]+\s*(it'?s|this is|that'?s|they'?re|we'?re|but)\b/i,
    /\b(isn'?t|wasn'?t|aren'?t) (just |only |merely |about )?[^.!?\n]{2,60}[.,;—–-]+\s*(it'?s|it was|they'?re|but)\b/i,
    /\bnot (just|only|merely) [^.!?\n]{2,60},? but\b/i,
    /\bless about [^.!?\n]{2,60} (and )?more about\b/i,
  ];
  const AI_GIVEAWAY = /\b(as an ai( language)? model|as a large language model|i (cannot|can't) (assist|help) with that request|i don'?t have personal (opinions|experiences))\b/i;
  const AI_THRESHOLDS = { low: 6, medium: 4, high: 2.5 };

  function aiScore(text) {
    if (!text) return 0;
    if (AI_GIVEAWAY.test(text)) return 99;
    if (text.length < 80) return 0;
    let score = 0;

    const emDashes = (text.match(/—/g) || []).length;
    score += Math.min(emDashes, 3) * 1.5;

    let phraseHits = 0;
    for (const re of AI_PHRASES) if (re.test(text)) phraseHits++;
    score += Math.min(phraseHits, 5) * 1.5;

    for (const re of AI_CONTRAST) {
      if (re.test(text)) {
        score += 3;
        break;
      }
    }

    // Emoji- or symbol-led bullet lists ("✅ Point one").
    const lines = text.split(/\n+/);
    let bullets = 0;
    for (const line of lines) {
      if (/^\s*(?:[•▪▶✅✔➡→]|[\u{1F300}-\u{1FAFF}]|\d️?⃣)/u.test(line)) bullets++;
    }
    if (bullets >= 3) score += 2;

    // Short punchy fragment runs: "No fluff. No hype. Just results."
    if (/\b(no|not|just|pure)\b[^.!?\n]{1,25}[.!]\s+(no|not|just|pure)\b[^.!?\n]{1,25}[.!]\s+\w[^.!?\n]{1,25}[.!]/i.test(text)) score += 2;

    // Colon-led reveal followed by a line break ("The result:\n").
    if (/\b(the (result|lesson|takeaway|truth|catch|problem|solution))[:?]\s*\n/i.test(text)) score += 1.5;

    return score;
  }

  // ------------------------------------------------------------- feed filter

  const hiddenIds = new Set();
  const counts = { foreign: 0, unverified: 0, ai: 0 };

  function getHandle(article) {
    const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (!link) return '';
    const m = link.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,20})(?:\/|$)/);
    return m ? m[1].toLowerCase() : '';
  }

  function getTweetId(article, handle) {
    const time = article.querySelector('a[href*="/status/"] time');
    const link = time && time.closest('a');
    if (link) return link.getAttribute('href');
    const textEl = article.querySelector('[data-testid="tweetText"]');
    return handle + ':' + (textEl ? textEl.textContent.slice(0, 80) : '');
  }

  // Returns '' to keep the post, or the reason it should be removed.
  function decide(article) {
    // The post you opened directly (its own page) is always shown.
    if (article.getAttribute('tabindex') === '-1' && /\/status\//.test(location.pathname)) return '';
    const handle = getHandle(article);
    if (!handle || allowSet.has(handle)) return '';

    if (settings.usOnly) {
      const entry = cache.get(handle);
      if (!entry) {
        enqueue(handle);
        if (settings.hideUnverified) return 'unverified';
      } else if (entry.c === '?') {
        if (settings.hideUnverified) return 'unverified';
      } else if (entry.c !== 'US') {
        return 'foreign';
      }
    }

    if (settings.aiFilter) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText || textEl.textContent : '';
      if (aiScore(text) >= AI_THRESHOLDS[settings.aiSensitivity]) return 'ai';
    }
    return '';
  }

  function scan() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const reason = decide(article);
      const cell = article.closest('[data-testid="cellInnerDiv"]') || article;
      const prev = cell.getAttribute('data-xus-hidden') || '';
      if (reason === prev) continue;
      if (reason) {
        cell.setAttribute('data-xus-hidden', reason);
        cell.style.setProperty('display', 'none', 'important');
        if (reason !== 'unverified' || cache.has(getHandle(article))) {
          const id = getTweetId(article, getHandle(article));
          if (!hiddenIds.has(id)) {
            hiddenIds.add(id);
            counts[reason]++;
          }
        }
      } else {
        cell.removeAttribute('data-xus-hidden');
        cell.style.removeProperty('display');
      }
    }
    updateUi();
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 100);
  }

  // --------------------------------------------------------------------- UI

  let ui = null;

  function buildUi() {
    const host = document.createElement('div');
    host.id = 'xus-root';
    host.style.cssText = 'position:fixed;left:12px;bottom:76px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .fab { display:flex; align-items:center; gap:6px; height:40px; padding:0 14px; border-radius:20px; border:1px solid #2f3336;
               background:#15202b; color:#fff; font-size:14px; font-weight:700; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.35); }
        .fab .n { font-weight:500; color:#8b98a5; }
        .fab.off { opacity:.6; }
        .panel { display:none; position:absolute; left:0; bottom:48px; width:300px; max-width:calc(100vw - 24px); max-height:70vh; overflow:auto;
                 padding:14px; border-radius:16px; border:1px solid #2f3336; background:#15202b; color:#e7e9ea; font-size:14px;
                 box-shadow:0 6px 24px rgba(0,0,0,.5); }
        .panel.open { display:block; }
        h1 { margin:0 0 10px; font-size:16px; }
        .row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:9px 0; border-top:1px solid #2f3336; }
        .row.sub { padding-left:14px; }
        .label { flex:1; }
        .label small { display:block; margin-top:2px; color:#8b98a5; font-size:12px; line-height:1.35; }
        .sw { position:relative; flex:none; width:44px; height:26px; }
        .sw input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }
        .sw span { position:absolute; inset:0; border-radius:13px; background:#536471; transition:background .15s; pointer-events:none; }
        .sw span::after { content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:transform .15s; }
        .sw input:checked + span { background:#1d9bf0; }
        .sw input:checked + span::after { transform:translateX(18px); }
        .sw input:focus-visible + span { outline:2px solid #fff; outline-offset:2px; }
        select, textarea, input[type=text] { width:100%; margin-top:6px; padding:7px 8px; border-radius:8px; border:1px solid #536471;
               background:#0f1419; color:#e7e9ea; font-size:14px; }
        select { width:auto; margin:0; }
        textarea { min-height:52px; resize:vertical; }
        .stats { padding:9px 0; border-top:1px solid #2f3336; color:#8b98a5; font-size:12px; line-height:1.5; }
        .stats b { color:#e7e9ea; }
        .warn { color:#ffd400; }
        button.link { padding:0; border:0; background:none; color:#1d9bf0; font-size:12px; cursor:pointer; }
        details { border-top:1px solid #2f3336; padding:9px 0 0; font-size:12px; color:#8b98a5; }
        summary { cursor:pointer; }
      </style>
      <div class="panel" part="panel">
        <h1>US-Only Feed Filter</h1>
        <div class="row">
          <div class="label">US accounts only<small>Remove posts from accounts X lists as based outside the United States.</small></div>
          <label class="sw"><input type="checkbox" data-k="usOnly" aria-label="US accounts only"><span></span></label>
        </div>
        <div class="row sub">
          <div class="label">Hide unverified<small>Also hide posts while the country is being checked, or when X shows none.</small></div>
          <label class="sw"><input type="checkbox" data-k="hideUnverified" aria-label="Hide unverified"><span></span></label>
        </div>
        <div class="row">
          <div class="label">Remove AI-sounding text<small>Pattern-based guess. It will miss some AI posts and occasionally hide human ones.</small></div>
          <label class="sw"><input type="checkbox" data-k="aiFilter" aria-label="Remove AI-sounding text"><span></span></label>
        </div>
        <div class="row sub">
          <div class="label">Sensitivity</div>
          <select data-k="aiSensitivity" aria-label="AI filter sensitivity">
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </div>
        <div class="row" style="display:block">
          <div class="label">Always show these accounts<small>Handles separated by spaces or commas.</small></div>
          <textarea data-k="allowlist" aria-label="Always show these accounts" placeholder="@nasa, @bbcworld"></textarea>
        </div>
        <div class="stats"></div>
        <details>
          <summary>Advanced</summary>
          <div style="margin-top:6px">AboutAccountQuery id (leave blank for automatic)</div>
          <input type="text" data-k="queryId" aria-label="AboutAccountQuery id" placeholder="${DEFAULT_QUERY_ID}">
          <div style="margin:8px 0 2px"><button class="link" data-act="clear">Clear saved country lookups</button></div>
        </details>
      </div>
      <button class="fab" aria-expanded="false" aria-label="US-Only Feed Filter settings">US <span class="n"></span></button>
    `;

    const panel = root.querySelector('.panel');
    const fab = root.querySelector('.fab');
    fab.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      fab.setAttribute('aria-expanded', String(open));
    });

    root.querySelectorAll('[data-k]').forEach((el) => {
      const key = el.getAttribute('data-k');
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
        settings[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
        saveSettings();
        scheduleScan();
      });
      // Keep X's keyboard shortcuts from firing while typing in our fields.
      el.addEventListener('keydown', (e) => e.stopPropagation());
    });

    root.querySelector('[data-act="clear"]').addEventListener('click', () => {
      cache.clear();
      retryAfter.clear();
      saveJson(CACHE_KEY, {});
      scheduleScan();
    });

    ui = { host, fab, count: root.querySelector('.fab .n'), stats: root.querySelector('.stats') };
    document.body.appendChild(host);
  }

  function updateUi() {
    if (!ui) return;
    if (!ui.host.isConnected && document.body) document.body.appendChild(ui.host);
    const total = counts.foreign + counts.unverified + counts.ai;
    const on = settings.usOnly || settings.aiFilter;
    ui.fab.classList.toggle('off', !on);
    ui.count.textContent = on ? String(total) : 'off';

    const lines = [
      'Removed this session: <b>' + counts.foreign + '</b> non-US, <b>' + counts.unverified +
        '</b> no country shown, <b>' + counts.ai + '</b> AI-sounding',
      'Accounts remembered: <b>' + cache.size + '</b>' + (queue.length + active ? ' · checking <b>' + (queue.length + active) + '</b>' : ''),
    ];
    if (Date.now() < pausedUntil) {
      const t = new Date(pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      lines.push('<span class="warn">X is rate-limiting country lookups. Resuming at ' + t + '.</span>');
    } else if (lastError) {
      lines.push('<span class="warn">' + lastError.replace(/[<>&]/g, '') + '</span>');
    }
    ui.stats.innerHTML = lines.join('<br>');
  }

  // ------------------------------------------------------------------- start

  function start() {
    buildUi();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scan();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  // Exposed for tests only.
  window.__xUsOnly = { aiScore, classifyCountry };
})();
