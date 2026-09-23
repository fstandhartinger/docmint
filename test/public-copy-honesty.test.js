'use strict';

// Guards every public page against copy that no longer matches the running product.
// Standalone: reads files only — no server, no database, no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const STALE = [
  'does not send email at all',
  'there is no password reset',
  'Rendered documents and PDFs are never written to the database',
  'unused files table',
  'DocMint never fetches anything on your behalf',
  'Render Services, Inc.',
  'Neon, Inc.',
  'Because there is no dashboard yet, Stripe returns you to /docs#quota',
  'Frankfurt',
  'DocMint never makes an outbound HTTP request on your behalf',
  'the service sends no email at all',
  'you may choose up to 7 days',
  'signed HTTPS POST',
  'there is currently no self-service account deletion',
  'no self-service account deletion; both are a request by email today',
  'account deletion is an email today',
  // AT13(d): the Google row named the wrong entity for an EEA operator and gave a
  // location neither fetched Google source establishes.
  "which forwards it via Google's SMTP service (Gmail, Google LLC)",
  // AT14: DocMint now draws QR codes, EPC payment QR codes and Code 128 / EAN-13
  // barcodes itself. These fragments said the opposite; their absence is guarded.
  'No rich text, QR codes, maps or dynamic PDF passwords',
  'You need charts, barcodes, HTML-into-Word, or PDF operations',
  'a studio, charts, barcodes or an on-premise licence',
  'You need rich text, QR codes, maps or dynamic PDF passwords',
  // The PDF open password shipped on /v1/render (2026-09-22), so the gap copy
  // that listed it under "does not do yet" is stale; its absence is guarded.
  'No rich text, maps or dynamic PDF passwords',
  'You need rich text, maps or dynamic PDF passwords',
];

// The old copy exactly as it read before the AT12 rewrite, so the fixture below cannot
// pass vacuously. Copied verbatim from public/privacy.html, public/docs.html and
// public/terms.html before they were edited.
const OLD_COPY = `
<p>DocMint sends exactly one kind of email: a transactional password-reset link, and only when you
   ask for one. The mail is sent through a relay on the same server, which forwards it via Google's
   SMTP service (Gmail, Google LLC). There is no newsletter, no marketing mail and no confirmation
   email.</p>
<h2>4. Email</h2>
<p>DocMint does not send email at all. There is no newsletter, no marketing mail and no transactional
   mail. One consequence is stated plainly in the <a href="/docs#signup">docs</a>: there is no password
   reset and no confirmation email.</p>
  <tr>
    <td><strong>The documents that are produced</strong></td>
    <td>Produced in memory and returned in the response. <strong>Rendered documents and PDFs are never written to the database.</strong> The schema contains an unused <code>files</code> table left over from a hosted-link feature that is not implemented; no code path writes to it or reads from it.</td>
    <td>Not stored.</td>
  </tr>
<h2>5. Outbound requests</h2>
<p><strong>DocMint never fetches anything on your behalf.</strong> An image referenced by URL in your
   data is not downloaded; you must supply its bytes. No template, no data and no document causes this
   service to contact any other host.</p>
  <tr><td>Render Services, Inc.</td><td>Runs the application and keeps HTTP request logs, which include IP addresses.</td><td>Frankfurt, Germany</td></tr>
  <tr><td>Neon, Inc.</td><td>Hosts the PostgreSQL database in which everything in section 2 is stored.</td><td>Frankfurt, Germany (EU region)</td></tr>
<p>The session collects a billing address and offers an optional VAT ID, which Stripe then puts on the invoice — an EU business needs it there or its accountant will not accept the receipt. Promotion codes are accepted. Because there is no dashboard yet, Stripe returns you to <code>/docs#quota</code> afterwards.</p>
  <p>There is <strong>no SLA</strong>. This is one small instance in one region (Frankfurt), restarted
<tr><td class="wrap"><code>{"url": "https://…"}</code></td><td class="wrap"><strong>Not fetched.</strong> DocMint never makes an outbound HTTP request on your behalf. Supply the bytes</td></tr>
<p>No. Nothing is read, mined, sold or used to train anything, and the service sends no email at all.</p>
<td>An async job's output is stored in the <code>files</code> table as a hosted download link; a link expires after 24 hours by default, and you may choose up to 7 days.</td>
<p>when an async job finishes, DocMint sends a signed HTTPS POST with the job status to the <code>webhook_url</code> you supplied.</p>
<p><strong>Being straight about deletion:</strong> there is currently no self-service account
  deletion, neither in the API nor in the dashboard. A deletion request has to be handled by hand by the
  operator.</p>
<span>Signed-in users can view usage and plan, manage templates, test a render and manage API keys in the browser. There are no team seats — every account is one login — and no self-service account deletion; both are a request by email today.</span>
<li><b>A small dashboard, no team seats.</b> Signed in, you can see usage and plan, upload templates,
test a render and manage API keys; everything also works as an API call. There are no team seats, and account
deletion is an email today.</li>
        <b>No rich text, QR codes, maps or dynamic PDF passwords</b>
<li><b>You need rich text, QR codes, maps or dynamic PDF passwords.</b> Docupilot has all four,
        <b>No rich text, maps or dynamic PDF passwords</b>
<li><b>You need rich text, maps or dynamic PDF passwords.</b> Docupilot has all three,
<tr><td>Charts, barcodes, HTML into Word</td><td>No</td><td>Yes (Enterprise Edition)</td>
<li><b>What is in the documents?</b> Charts, barcodes, formatted HTML flowed into Word, QR codes,
exactly that. If the thing you need is a studio, charts, barcodes or an on-premise licence, Carbone
<li><b>You need rich text, QR codes, maps or dynamic PDF passwords.</b> Docupilot has all four,
<li><b>You need charts, barcodes, HTML-into-Word, or PDF operations.</b> Carbone's Enterprise
`;

test('OLD_COPY fixture really contains every stale fragment (no vacuous pass)', () => {
  const text = visibleText(OLD_COPY);
  for (const fragment of STALE) {
    assert.ok(
      text.includes(fragment.toLowerCase()),
      `OLD_COPY fixture is missing the stale fragment it is supposed to prove exists: ${JSON.stringify(fragment)}`,
    );
  }
});

test('no public page contains stale copy', () => {
  const files = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
  assert.ok(files.length > 0, 'no public/*.html files found');
  for (const file of files) {
    const text = visibleText(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
    for (const fragment of STALE) {
      assert.ok(
        !text.includes(fragment.toLowerCase()),
        `${file}: stale fragment found: ${JSON.stringify(fragment)}`,
      );
    }
  }
});

test('images documentation examples contain valid API request JSON', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'docs.html'), 'utf8');
  const section = html.match(/<section id="images">([\s\S]*?)<\/section>/)[1];
  const examples = [...section.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]);
  assert.equal(examples.length, 2);
  const images = JSON.parse(examples[0]);
  assert.equal(images.template, 'deck');
  assert.ok(images.images[images.data.logo.url].data);
  assert.match(examples[1], /Authorization: Bearer /);
  const request = JSON.parse(examples[1].match(/-d\s+'([\s\S]*?)'/)[1]);
  assert.equal(request.template, 'letter');
  assert.equal(request.output, 'pdf');
  assert.ok(!Object.hasOwn(request, 'format'));
  assert.deepEqual(Object.keys(request.data).sort(), ['bar', 'ean', 'pay', 'qr']);
});

test('images documentation has balanced structural tags', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'docs.html'), 'utf8');
  const section = html.match(/<section id="images">([\s\S]*?)<\/section>/)[1];
  const stack = [];
  for (const tag of section.matchAll(/<(\/?)(div|table|thead|tbody|tr|th|td|pre|code)\b[^>]*>/g)) {
    if (tag[1]) assert.equal(stack.pop(), tag[2], `unmatched closing ${tag[2]}`);
    else stack.push(tag[2]);
  }
  assert.deepEqual(stack, []);
});

test('privacy policy names the running product', () => {
  const text = visibleText(fs.readFileSync(path.join(PUBLIC_DIR, 'privacy.html'), 'utf8'));
  for (const wanted of ['Hetzner Online GmbH', 'password', 'Google', '7 days', 'SHA-256']) {
    assert.ok(text.includes(wanted.toLowerCase()), `privacy.html is missing ${JSON.stringify(wanted)}`);
  }
  assert.ok(
    text.includes('webhook_url'),
    'privacy.html is missing the webhook row',
  );
  assert.doesNotMatch(
    text,
    /password_reset_limits[^.]*within/i,
    'privacy.html must not promise a retention period for the password-reset hashes',
  );
});

// AT-V2b/AT-V5: the visitor-statistics copy must state the own-zone rule the
// running code implements — subdomains of our own domain zone are our own
// traffic (views, not visits, no host stored), direct loads count as visits,
// and views/visits have the zone-based meanings.
test('privacy states the own-domain-zone rule of the visitor statistics', () => {
  const text = visibleText(fs.readFileSync(path.join(PUBLIC_DIR, 'privacy.html'), 'utf8'));
  for (const wanted of [
    'own domain zone (mintapis.com)',
    'referrers from subdomains of our own domain zone',
    'treated as our own traffic',
    'count as views, not as visits',
    'no host is stored for them',
    'entries from outside our domain zone',
    'a load with no referrer at all counts as a visit',
    'page loads were served (these are the views)',
  ]) {
    assert.ok(text.includes(wanted.toLowerCase()),
      `privacy.html is missing the visitor-statistics statement ${JSON.stringify(wanted)}`);
  }
});
