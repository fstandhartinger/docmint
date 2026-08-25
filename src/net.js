'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const { config } = require('./config');
const { bad } = require('./errors');

/**
 * Outbound URL safety, for the one place DocMint is told to call somebody:
 * a job's `webhook_url`.
 *
 * Without this, the webhook field is a server-side request forgery primitive
 * handed to anyone with a free API key. `{"webhook_url":"http://169.254.169.254/
 * latest/meta-data/iam/security-credentials/"}` would make our own instance fetch
 * the cloud metadata endpoint; a webhook pointed at `http://127.0.0.1:3000/v1/...`
 * would reach admin surfaces that are only reachable from inside. The name does
 * not have to be an address either — `evil.example` with an A record of
 * 169.254.169.254 is the same attack with one more step, which is why the host is
 * resolved before it is trusted, and why every redirect hop is checked again
 * rather than handed to fetch's own follower.
 */

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

/** Redirect hops we will follow. Three is enough for a real load balancer. */
const MAX_REDIRECTS = 3;

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;           // link-local, and every cloud metadata service
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking range
  if (a >= 224) return true;                          // multicast and reserved
  return false;
}

function isPrivateIpv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
  // ::ffff:169.254.169.254 is the metadata endpoint wearing a hat.
  if (s.startsWith('::ffff:')) return isPrivateIpv4(s.slice(7));
  return false;
}

/** Unknown shapes are treated as private: refusing something reachable is a bug report, allowing something internal is an incident. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true;
}

/**
 * Throws unless `raw` is an http(s) URL whose host resolves to a public address.
 * Returns the parsed URL.
 */
async function assertPublicUrl(raw, field = 'webhook_url') {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw bad('invalid_url', `"${field}" is not a valid URL.`, {
      hint: 'Include the scheme, for example https://example.com/hooks/docmint.',
      docs: '/docs#async',
    });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw bad('unsupported_url_scheme', `"${field}" must use http:// or https://, got ${u.protocol}//.`, {
      hint: 'file:, data: and ftp: URLs are not webhooks and are never called.',
      docs: '/docs#async',
    });
  }
  if (config.allowPrivateNetwork) return u;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    throw bad('private_address_blocked', `"${field}" points at ${host}, which is not reachable from DocMint.`, {
      hint: 'DocMint calls the webhook from its own servers, so the URL has to be reachable from the public internet. A tunnel such as ngrok gives a laptop a public URL.',
      docs: '/docs#async',
    });
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw bad('private_address_blocked', `"${field}" points at the private address ${host}.`, {
        hint: 'DocMint calls the webhook from its own servers, so the URL has to be reachable from the public internet. A tunnel such as ngrok gives a laptop a public URL.',
        docs: '/docs#async',
      });
    }
    return u;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw bad('dns_failed', `Could not resolve the host "${host}".`, {
      hint: 'Check the spelling, and that the name is resolvable from the public internet rather than only inside your network.',
      docs: '/docs#async',
    });
  }
  // `some`, not `every`: a name that resolves to one public and one private
  // address is still a way into the private one, so the whole name is refused.
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw bad('private_address_blocked', `"${field}" resolves to a private address.`, {
      hint: 'DocMint calls the webhook from its own servers, so the URL has to be reachable from the public internet. A tunnel such as ngrok gives a laptop a public URL.',
      docs: '/docs#async',
    });
  }
  return u;
}

/**
 * POSTs a signed webhook body, following redirects by hand.
 *
 * `redirect: 'manual'` rather than fetch's own follower, because fetch would
 * happily follow a 302 from a public host to http://169.254.169.254 and the
 * check above would have been decoration. Every hop is re-validated.
 *
 * The method stays POST across the redirect, including on 303. A 303 formally
 * means "now GET this", but the signature covers the body; dropping the body
 * would deliver something the receiver cannot verify, which is worse than not
 * delivering at all.
 *
 * Returns {ok, status, url, error} and never throws.
 */
async function postJson(rawUrl, { body, headers = {}, timeoutMs = 15000 } = {}) {
  let url = String(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await assertPublicUrl(url, 'webhook_url');
    } catch (e) {
      return { ok: false, status: null, url, error: e.code === 'private_address_blocked' || e.code === 'dns_failed' ? e.message : String(e.message) };
    }
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(url, {
        method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: null, url, error: String(e.message || e).slice(0, 200) };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === MAX_REDIRECTS) {
        return { ok: false, status: res.status, url, error: `more than ${MAX_REDIRECTS} redirects` };
      }
      try {
        url = new URL(res.headers.get('location'), url).toString();
      } catch {
        return { ok: false, status: res.status, url, error: 'redirect Location is not a usable URL' };
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    return { ok: res.ok, status: res.status, url, error: res.ok ? null : `HTTP ${res.status}` };
  }
  return { ok: false, status: null, url, error: 'redirect loop' };
}

module.exports = { assertPublicUrl, isPrivateAddress, postJson, MAX_REDIRECTS };
