// Patchright/cloak stock watcher.
//
// Sweeps all stores in config.yaml every `interval` seconds. If a store
// passes ALL its checks, sends a max-priority ntfy push whose tap opens
// the product URL. One push per restock: a store must go back out of
// stock before it can alert again.
//
// Usage:
//   node watch.js              # continuous sweep
//   node watch.js --once       # single sweep, then exit
//   node watch.js --dump 6     # render store #6, print detection info, exit

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { launch } from 'cloakbrowser';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.SCRAPE_PROCON_CONFIG
  ?? path.join(__dirname, 'config.yaml');

// Loads CLOAKBROWSER_LICENSE_KEY etc. No-op if the file is missing.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

// cloakbrowser's binary cache must live on writable disk, not the nix store.
if (process.env.SCRAPE_PROCON_CACHE_DIR) {
  process.env.CLOAKBROWSER_CACHE_DIR = process.env.SCRAPE_PROCON_CACHE_DIR;
}

const windowsFontsDirectory = process.env.SCRAPE_PROCON_WIN_FONTS
  ?? `${process.env.HOME}/.local/share/fonts/windows`;
const windowsFingerprintArgs = [
  '--fingerprint-platform=windows',
  `--fingerprint-fonts-dir=${windowsFontsDirectory}`,
  '--fingerprint-windows-font-metrics',
];

const FINGERPRINTS = {
  windows: windowsFingerprintArgs,
};

const cfg = parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const stores = Object.entries(cfg.stores).map(([name, spec]) => ({
  name,
  url: spec.url,
  engine: spec.engine ?? 'cloak',
  settleMs: spec.settle_ms ?? 3000,
  fingerprint: spec.fingerprint ?? null,
  launchArgs: spec.launch_args ?? [],
  checks: spec.checks ?? [],
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Detection

function schemaAvailability(blobs) {
  const out = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (typeof n.availability === 'string') {
        out.add(n.availability.split('/').pop().toLowerCase());
      }
      Object.values(n).forEach(walk);
    }
  };
  blobs.forEach(walk);
  return out;
}

function evaluateTextChecks(text, blobs, checks) {
  if (!checks.length) return { ok: false, reason: 'no checks configured' };

  const low = text.toLowerCase();
  for (const [i, c] of checks.entries()) {
    for (const t of c.text_present ?? []) {
      if (!low.includes(t.toLowerCase())) return { ok: false, reason: `missing text '${t}'` };
    }
    for (const t of c.text_absent ?? []) {
      if (low.includes(t.toLowerCase())) return { ok: false, reason: `found disqualifying text '${t}'` };
    }
  }

  // Definitive schema.org availability wins over button text.
  const avail = schemaAvailability(blobs);
  if (avail.has('instock')) return { ok: true, reason: 'schema availability=InStock' };
  if (['soldout', 'discontinued', 'outofstock'].some((a) => avail.has(a))) {
    return { ok: false, reason: 'schema availability=OutOfStock' };
  }

  return { ok: true, reason: 'all text checks passed' };
}

// ---------------------------------------------------------------------------
// ntfy

async function sendNtfy(store) {
  const { server, topic, title_prefix: prefix } = cfg.ntfy;
  const res = await fetch(`${server}/${topic}`, {
    method: 'POST',
    body: `${store.name} appears IN STOCK.\n${store.url}`,
    headers: {
      Title: `${prefix}: ${store.name}`,
      Priority: 'max',
      Tags: 'shopping_cart',
      // Tapping the notification opens the product page.
      Click: store.url,
    },
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Checking

async function extractPage(page) {
  const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
  const blobs = await page.evaluate(() => {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { out.push(JSON.parse(s.textContent)); } catch {}
    }
    return out;
  });
  return { text, blobs };
}

async function checkStore(store) {
  const { ctx } = await launchFor(store);
  const page = await ctx.newPage();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(store.url, {
          waitUntil: 'domcontentloaded',
          timeout: cfg.page_timeout * 1000,
        });
        break;
      } catch (e) {
        if (attempt === 2) return { inStock: false, reason: `load error: ${e.message.split('\n')[0]}` };
        await page.goto('about:blank').catch(() => {});
      }
    }

    // Give client-side rendering a beat.
    await sleep(store.settleMs);

    const { text, blobs } = await extractPage(page);
    const textResult = evaluateTextChecks(text, blobs, store.checks);
    if (!textResult.ok) return { inStock: false, reason: textResult.reason };

    for (const [i, c] of store.checks.entries()) {
      for (const sel of c.css_present ?? []) {
        if ((await page.locator(sel).count()) === 0) {
          return { inStock: false, reason: `check ${i}: css_present no match: ${sel}` };
        }
      }
      for (const sel of c.css_absent ?? []) {
        if ((await page.locator(sel).count()) > 0) {
          return { inStock: false, reason: `check ${i}: css_absent match: ${sel}` };
        }
      }
    }

    return { inStock: true, reason: textResult.reason };
  } catch (e) {
    return { inStock: false, reason: `evaluate error: ${e.message.split('\n')[0]}` };
  } finally {
    await page.close();
  }
}

const browserCache = new Map(); // launchArgs key -> { browser, ctx }

async function launchFor(store) {
  const key = `${store.engine}:${store.launchArgs.join(' ')}`;
  if (!browserCache.has(key)) {
    const browser =
      store.engine === 'helium'
        ? await chromium.launch({ executablePath: cfg.helium_path, headless: true })
        : await launch({
            headless: true,
            args: [...(FINGERPRINTS[store.fingerprint] ?? []), ...store.launchArgs],
          });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      // Only override UA for plain-Chromium engines; cloak's own UA is
      // part of its coherent Windows fingerprint.
      ...(store.engine === 'helium' && cfg.user_agent ? { userAgent: cfg.user_agent } : {}),
    });
    browserCache.set(key, { browser, ctx });
  }
  return browserCache.get(key);
}

async function runSweep(state) {
  for (const store of stores) {
    const { inStock, reason } = await checkStore(store);
    const prev = state.get(store.name) ?? false;
    console.log(`  ${store.name.padEnd(24)} ${inStock ? 'IN STOCK' : 'out'}${' '.repeat(inStock ? 1 : 4)} (${reason})`);

    if (inStock && !prev) {
      console.log(`  -> notifying for ${store.name}`);
      try {
        await sendNtfy(store);
      } catch (e) {
        console.error(`  !! ntfy send failed: ${e.message}`);
      }
    }
    state.set(store.name, inStock);
  }
}

// ---------------------------------------------------------------------------
// Dump (selector tuning)

async function dumpStore(ctx, idx) {
  const store = stores[idx];
  const page = await ctx.newPage();
  console.log(`Loading ${store.name}: ${store.url}`);
  await page.goto(store.url, { waitUntil: 'domcontentloaded', timeout: cfg.page_timeout * 1000 });
  await sleep(5000);

  const { text, blobs } = await extractPage(page);
  const avail = schemaAvailability(blobs);

  fs.writeFileSync(path.join(__dirname, 'dump.txt'), text);
  console.log(`\nBody text written to dump.txt (${text.length} chars).`);
  console.log(`Schema availability tokens: ${[...avail].join(', ') || '(none)'}`);

  const buttons = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[role=button], [class*=cart i], [class*=buy i]')) {
      const t = (el.innerText || '').trim();
      if (t && t.length < 60) out.push(`<${el.tagName.toLowerCase()} class="${el.className}">${t}`);
    }
    return out.slice(0, 40);
  });
  console.log('\nButtons / CTAs:');
  for (const b of buttons) console.log(`  ${b}`);
  await page.close();
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dumpIdx = args.includes('--dump') ? Number(args[args.indexOf('--dump') + 1]) - 1 : null;
const once = args.includes('--once');
const testNotify = args.includes('--test-notify');

try {
  if (testNotify) {
    console.log(`Sending test push for ${stores[0].name} to ${cfg.ntfy.server}/${cfg.ntfy.topic} ...`);
    await sendNtfy(stores[0]);
    console.log('Sent. Check your phone — tapping should open the product page.');
  } else if (dumpIdx !== null) {
    const { ctx } = await launchFor(stores[dumpIdx]);
    await dumpStore(ctx, dumpIdx);
  } else {
    const state = new Map();
    while (true) {
      console.log(`\n=== sweep ${new Date().toLocaleTimeString()} ===`);
      await runSweep(state);
      if (once) break;
      const jitter = cfg.jitter ?? 0;
      const waitS = cfg.interval + (Math.random() * 2 - 1) * jitter;
      await sleep(waitS * 1000);
    }
  }
} finally {
  for (const { browser } of browserCache.values()) await browser.close();
}
