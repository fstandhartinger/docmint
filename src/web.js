'use strict';

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

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SESSION_COOKIE = 'docmint_session';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shell(title, body) {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${css}</style></head><body>${body}</body></html>`;
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
  return match ? decodeURIComponent(match[1]) : null;
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

router.get('/dashboard', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const fullKey = takeKeyForSession(sessionIdFrom(req));
  const plan = PLANS[account.plan] || PLANS.free;
  const remaining = Math.max(0, account.credits_limit - account.credits_used);
  const pct = Math.min(100, Math.round((account.credits_used / Math.max(1, account.credits_limit)) * 100));
  const purchasable = Object.values(PLANS).filter((candidate) => planPriceId(candidate.id));

  return res.type('html').send(shell('DocMint dashboard', `
<header class="topbar"><a class="logo" href="/">Doc<span>Mint</span></a>
  <nav><a href="/docs">Docs</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav></header>
<main class="dash">
  ${req.query.welcome ? '<div class="notice"><strong>Your account is ready.</strong> Copy the API key below now. It is shown only once.</div>' : ''}
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
    <p class="muted">${remaining.toLocaleString('en-US')} credits remaining. Plan: <strong>${escapeHtml(plan.name)}</strong>${plan.priceUsd ? ` — $${plan.priceUsd}/month` : ' — free'}. Resets on the 1st.</p>
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
    ${purchasable.length ? '' : '<p class="muted">Paid plans are not configured on this build.</p>'}
  </section>
</main>
<script>document.addEventListener('click', (event) => {
  const button = event.target.closest('.copy'); if (!button) return;
  navigator.clipboard.writeText(document.getElementById(button.dataset.target).textContent.trim());
  button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});</script>`));
}));

router.post('/dashboard/checkout', asyncRoute(async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.redirect('/login');
  const session = await billing.createCheckoutSession(account, String(req.body?.plan || ''));
  return res.redirect(303, session.url);
}));

module.exports = { router, currentAccount };
