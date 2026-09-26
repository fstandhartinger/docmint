#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readdir, readFile } = require('node:fs/promises');

/**
 * Tell search engines the pages exist, instead of waiting to be found.
 *
 * IndexNow is one endpoint that Bing, Yandex, Seznam and Naver all consume: you
 * host a key file at your root and POST a list of URLs. It is free, needs no
 * account, and is the fastest route to being crawled by them for a site with no
 * inbound links yet. Google does not take part — for Google the levers are the
 * sitemap in robots.txt, Search Console, and links.
 *
 *   node scripts/submit-indexnow.js
 *
 * Run it after a deploy that adds or changes a public page.
 */

const HOST = 'docmint.app.mintapis.com';
const SITE_ROOT = `https://${HOST}`;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const KEY_FILE_RE = /^([0-9a-f]{32})\.txt$/i;

async function keyFromPublicFile() {
  const names = (await readdir(PUBLIC_DIR)).filter((name) => KEY_FILE_RE.test(name));
  if (names.length !== 1) {
    throw new Error(`expected one 32-character IndexNow key file in ${PUBLIC_DIR}, found ${names.length}`);
  }

  const filename = names[0];
  const key = (await readFile(path.join(PUBLIC_DIR, filename), 'utf8')).trim();
  if (filename !== `${key}.txt` || !KEY_FILE_RE.test(filename)) {
    throw new Error(`IndexNow key file ${filename} must contain the same key as its filename`);
  }
  if (process.env.INDEXNOW_KEY && process.env.INDEXNOW_KEY !== key) {
    throw new Error('INDEXNOW_KEY does not match the key file under public/');
  }
  return key;
}

function parseSitemap(xml) {
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (!urls.length) throw new Error('sitemap contains no <loc> URLs');
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.host !== HOST) {
      throw new Error(`sitemap URL is not on the canonical DocMint host: ${value}`);
    }
  }
  return urls;
}

async function urlsFromSitemap() {
  const res = await fetch(`${SITE_ROOT}/sitemap.xml`);
  if (!res.ok) throw new Error(`sitemap returned ${res.status}`);
  return parseSitemap(await res.text());
}

async function main() {
  const key = await keyFromPublicFile();

  // The key file has to be reachable, or every submission is rejected as
  // unverified — check it before sending anything.
  const probe = await fetch(`${SITE_ROOT}/${key}.txt`);
  if (!probe.ok || (await probe.text()).trim() !== key) {
    console.error(`key file at ${SITE_ROOT}/${key}.txt is missing or does not contain the local key`);
    process.exitCode = 1;
    return;
  }

  const urlList = await urlsFromSitemap();
  console.log(`submitting ${urlList.length} urls`);

  const res = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key, keyLocation: `${SITE_ROOT}/${key}.txt`, urlList }),
  });

  // 200 and 202 both mean accepted; 422 usually means the key did not verify.
  console.log(`indexnow responded ${res.status} ${res.statusText}`);
  if (res.status >= 400) {
    console.error((await res.text()).slice(0, 300));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('submission failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { HOST, SITE_ROOT, keyFromPublicFile, parseSitemap };
