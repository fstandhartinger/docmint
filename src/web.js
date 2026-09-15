'use strict';

const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { config, PLANS, planPriceId } = require('./config');
const { query } = require('./db');
const {
  createAccount, verifyLogin, createSession, accountForSession, destroySession,
  stashKeyForSession, takeKeyForSession,
} = require('./auth');
const billing = require('./billing');
const analytics = require('./analytics');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SESSION_COOKIE = 'docmint_session';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shell(title, body, extraHead = '', scripts = '') {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${extraHead}<style>${css}</style></head><body>${body}${scripts}</body></html>`;
}

function csrfToken(sessionId) {
  return crypto.createHmac('sha256', config.sessionSecret).update(String(sessionId || '')).digest('hex');
}

function setSessionCookie(res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

function sessionIdFrom(req) {
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

async function currentAccount(req) {
  return accountForSession(sessionIdFrom(req));
}

function authForm(kind, error, values = {}) {
  const signup = kind === 'signup';
  return shell(signup ? 'Create your DocMint account' : 'Sign in to DocMint', `
<main class="auth">
  <a class="logo" href="/">Doc<span>Mint</span></a>
  <h1>${signup ? 'Create your account' : 'Sign in'}</h1>
  <p class="sub">${signup ? '30 documents a month, free, no card.' : 'Welcome back.'}</p>
  ${signup ? '<p class="muted">Use an email address you can access. You can reset your password by email.</p>' : ''}
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/${kind}">
    <label>Email<input type="email" name="email" required autocomplete="email" value="${escapeHtml(values.email)}"></label>
    <label>Password<input type="password" name="password" required minlength="10" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
    <button type="submit">${signup ? 'Create account' : 'Sign in'}</button>
  </form>
  <p class="alt"><a href="/forgot-password">Forgot password?</a></p>
  <p class="alt">${signup ? 'Already have an account? <a href="/login">Sign in</a>' : 'No account yet? <a href="/signup">Create one</a>'}</p>
</main>`);
}

require('./recovery').install(router, { product: 'DocMint', shell, minLength: 10 });

router.get('/signup', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  return res.type('html').send(authForm('signup'));
}));

router.post('/signup', asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) {
    return res.status(400).type('html').send(authForm('signup', 'That does not look like an email address.', { email }));
  }
  if (password.length < 10) {
    return res.status(400).type('html').send(authForm('signup', 'The password must be at least 10 characters.', { email }));
  }

  let created;
  try {
    // This is the same account creation path as POST /v1/signup: it hashes the
    // password, creates the free account and issues the first API key.
    created = await createAccount(email, password);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).type('html').send(authForm('signup', 'That email already has an account. Sign in instead.', { email }));
    }
    throw error;
  }

  const sessionId = await createSession(created.account.id);
  setSessionCookie(res, sessionId);
  stashKeyForSession(sessionId, created.apiKey);
  req.log.info('signup.web_ok', { account: created.account.id });
  // AT9: one counter per created account, on success only. Fire-and-forget on
  // purpose — increment() cannot throw, and a redirect must never wait on it.
  analytics.increment('signup');
  return res.redirect('/dashboard?welcome=1');
}));

router.get('/login', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  return res.type('html').send(authForm('login'));
}));

router.post('/login', asyncRoute(async (req, res) => {
  const account = await verifyLogin(req.body?.email || '', req.body?.password || '');
  if (!account) return res.status(401).type('html').send(authForm('login', 'Wrong email or password.', { email: req.body?.email }));
  setSessionCookie(res, await createSession(account.id));
  return res.redirect('/dashboard');
}));

router.post('/logout', asyncRoute(async (req, res) => {
  const sessionId = sessionIdFrom(req);
  if (sessionId) await destroySession(sessionId);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect('/');
}));

router.post('/dashboard/billing-portal', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const sessionId = sessionIdFrom(req);
  const expected = Buffer.from(csrfToken(sessionId), 'utf8');
  const supplied = Buffer.from(typeof req.body?.csrf === 'string' ? req.body.csrf : '', 'utf8');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).type('text').send('Invalid CSRF token.');
  }
  try {
    const session = await billing.createPortalSession(account, { returnPath: '/dashboard' });
    return res.redirect(303, session.url);
  } catch (error) {
    if (error?.code === 'no_subscription') return res.redirect(303, '/dashboard?billing=none');
    if (error?.code === 'billing_unavailable') return res.redirect(303, '/dashboard?billing=unavailable');
    req.log.warn('dashboard.billing_portal_failed', { account: account.id, code: error?.code });
    return res.redirect(303, '/dashboard?billing=error');
  }
}));

router.get('/dashboard', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  // C3: `?checkout=success` is a query parameter, not a receipt. Nothing about
  // the banner is decided from the URL — billing.verifyCheckoutReturn asks Stripe
  // whether THIS session, belonging to THIS account, was actually paid, and
  // whether our own fulfilment has landed. Everything else gets neutral text.
  const checkoutReturn = req.query.checkout === 'success'
    ? await billing.verifyCheckoutReturn(account, typeof req.query.session_id === 'string' ? req.query.session_id : null)
    : null;
  const sessionId = sessionIdFrom(req);
  const fullKey = takeKeyForSession(sessionId);
  const csrf = csrfToken(sessionId);
  const plan = PLANS[account.plan] || PLANS.free;
  const remaining = Math.max(0, account.credits_limit - account.credits_used);
  const pct = Math.min(100, Math.round((account.credits_used / Math.max(1, account.credits_limit)) * 100));
  const purchasable = Object.values(PLANS).filter((candidate) => planPriceId(candidate.id));

  return res.type('html').send(shell('DocMint dashboard', `
<header class="topbar"><a class="logo" href="/">Doc<span>Mint</span></a>
  <nav><a href="/docs">Docs</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav></header>
<main class="dash">
  ${req.query.billing === 'none' ? '<div class="notice">There is no billing record for this account yet. Choose a plan below to start one.</div>' : ''}
  ${req.query.billing === 'unavailable' ? '<div class="notice">Billing is not available on this deployment right now.</div>' : ''}
  ${req.query.billing === 'error' ? '<div class="notice">Stripe\'s billing page could not be opened just now. Nothing was changed. Please try again in a minute.</div>' : ''}
  ${req.query.welcome ? '<div class="notice"><strong>Your account is ready.</strong> Copy the API key below now. It is shown only once.</div>' : ''}
  ${checkoutReturn ? `<div class="notice${checkoutReturn.ok ? ' ok' : ''}">${escapeHtml(checkoutReturn.message)}</div>` : ''}
  ${req.query.checkout === 'updated' ? '<div class="notice">Your plan change has been sent to Stripe. The plan shown below is the one you are on right now; it updates as soon as Stripe confirms.</div>' : ''}
  ${req.query.checkout === 'pending' ? '<div class="notice">Your upgrade is waiting on payment. Nothing has changed yet — your plan below is the one you are on.</div>' : ''}
  ${req.query.checkout === 'cancelled' ? '<div class="notice">Checkout cancelled. Nothing was charged.</div>' : ''}
  <h1>Dashboard</h1>
  <section class="card">
    <h2>API key</h2>
    ${fullKey ? `<p class="keybox"><code id="api-key">${escapeHtml(fullKey)}</code><button class="copy" data-target="api-key">Copy</button></p>
      <p class="muted">This key is shown once and cannot be read back. Store it in your password manager or secrets vault now.</p>`
      : '<p class="muted">API keys are only shown when they are created. Your existing key continues to work.</p>'}
  </section>
  <section class="card">
    <h2>Usage this month</h2>
    <p class="big">${account.credits_used.toLocaleString('en-US')} <span class="muted">of ${account.credits_limit.toLocaleString('en-US')} credits used</span></p>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <p class="muted"><span id="credits-remaining">${remaining.toLocaleString('en-US')}</span> credits remaining. Plan: <strong>${escapeHtml(plan.name)}</strong>${plan.priceUsd ? ` — $${plan.priceUsd}/month` : ' — free'}. Resets on the 1st.</p>
  </section>
  <section class="card">
    <h2>Plan</h2>
    <div class="plans">
      ${purchasable.map((candidate) => `<div class="plan${account.plan === candidate.id ? ' current' : ''}">
        <h3>${escapeHtml(candidate.name)}</h3><p class="price">$${candidate.priceUsd}<span>/mo</span></p>
        <p class="muted">${candidate.credits.toLocaleString('en-US')} credits / month</p>
        ${account.plan === candidate.id ? '<p class="tag">Current plan</p>' : `<form method="post" action="/dashboard/checkout"><input type="hidden" name="plan" value="${candidate.id}"><button>Choose ${escapeHtml(candidate.name)}</button></form>`}
      </div>`).join('')}
    </div>
    ${purchasable.length ? '' : `<p class="muted">Paid plans are not configured on this build.</p>`}
    ${billing.enabled() && account.stripe_customer_id ? `<form method="post" action="/dashboard/billing-portal" class="portal"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Manage billing</button></form><p class="muted">Invoices, payment method and cancellation are handled on Stripe's secure billing page.</p>` : ''}
  </section>
  <section class="card">
    <h2>Templates</h2>
    <p class="error" id="templates-error" role="alert" hidden></p>
    <p class="muted" id="templates-empty" hidden>No templates yet. Upload a .docx, .xlsx or .pptx below, or use POST /v1/templates.</p>
    <div class="tablewrap">
      <table class="rows" id="templates-table" hidden>
        <thead><tr><th>Name</th><th>Format</th><th>Version</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody id="templates-body"></tbody>
      </table>
    </div>
  </section>
  <section class="card">
    <h2>Upload a template</h2>
    <form id="upload-form" class="stack">
      <label for="upload-name">Template name</label>
      <input id="upload-name" name="name" type="text" required maxlength="64" autocomplete="off">
      <label for="upload-file">Template file (.docx, .xlsx or .pptx)</label>
      <input id="upload-file" name="file" type="file" required accept=".docx,.dotx,.docm,.xlsx,.xltx,.xlsm,.pptx,.potx,.ppsx,.pptm">
      <div><button type="submit">Upload</button></div>
    </form>
    <p class="error" id="upload-error" role="alert" hidden></p>
  </section>
  <section class="card">
    <h2>Test a render</h2>
    <p class="muted" id="render-none">Choose a template from the list above to try it. A document costs 1 credit, a PDF 2.</p>
    <div id="render-detail" hidden>
      <p>Template: <strong id="render-name"></strong></p>
      <p class="muted" id="render-fields"></p>
      <div class="stack">
        <label for="render-data">Data (JSON)</label>
        <textarea id="render-data" rows="14" spellcheck="false"></textarea>
        <div class="btnrow">
          <button type="button" id="render-doc">Render document</button>
          <button type="button" id="render-pdf">Render PDF</button>
        </div>
      </div>
    </div>
    <p class="error" id="render-error" role="alert" hidden></p>
  </section>
  <section class="card">
    <h2>API keys</h2>
    <p class="muted">Keys are shown only once, when they are created. This list shows prefixes, never the keys themselves.</p>
    <p class="error" id="keys-error" role="alert" hidden></p>
    <div class="tablewrap">
      <table class="rows" id="keys-table">
        <thead><tr><th>Prefix</th><th>Label</th><th>Created</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody id="keys-body"></tbody>
      </table>
    </div>
    <form id="key-form" class="stack">
      <label for="key-label">Label for a new key</label>
      <input id="key-label" name="label" type="text" required maxlength="60" autocomplete="off">
      <div><button type="submit">Create key</button></div>
    </form>
    <div class="notice" id="new-key-notice" hidden>
      <p><strong>Your new key.</strong> It is shown only once, so copy it now.</p>
      <p class="keybox"><code id="new-key"></code><button type="button" id="new-key-copy">Copy</button></p>
    </div>
  </section>
</main>
<script>document.addEventListener('click', (event) => {
  const button = event.target.closest('.copy'); if (!button) return;
  navigator.clipboard.writeText(document.getElementById(button.dataset.target).textContent.trim());
  button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});</script>`,
  `<meta name="docmint-csrf" content="${csrf}">`,
  '<script src="/dashboard.js" defer></script>'));
}));

router.post('/dashboard/checkout', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const session = await billing.createCheckoutSession(account, String(req.body?.plan || ''));
  return res.redirect(303, session.url);
}));

module.exports = { router, currentAccount, sessionIdFrom, csrfToken, escapeHtml };
