/**
 * Synthetic event generator. Every site, device, IP, URL and order id is made
 * up for this demo. There is no real user tracking: the script writes NDJSON
 * files to disk, nothing is sent anywhere.
 *
 * Defects are scheduled deterministically (a fixed count per day) instead of
 * being drawn at random, so every rule in the catalog has a known, explainable
 * example in the seeded data. Organic sessions fill the remaining volume.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, zonedTimeIso } from '../lib/time.mjs';

const SITES = [
  { site_id: 'demo-site-alpha', placements: ['pl-home-hero', 'pl-article-inline', 'pl-sidebar'] },
  { site_id: 'demo-site-beta', placements: ['pl-feed-top', 'pl-video-leader'] },
];

const UAS = {
  clean: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ],
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/118.0.0.0 Safari/537.36',
};

const NAV = ['typed', 'internal', 'external', 'reload'];
const DATACENTER_IPS = ['203.0.113.14', '203.0.113.87', '198.51.100.23'];

/** Planned sessions per day. `count` entries of each scenario are emitted. */
const DAILY_PLAN = [
  { scenario: 'fastClick', count: 2 },
  { scenario: 'lateClick', count: 1 },
  { scenario: 'lateConversion', count: 1 },
  { scenario: 'datacenter', count: 1 },
  { scenario: 'headless', count: 1 },
  { scenario: 'invisibleImpression', count: 1 },
  { scenario: 'orphanClick', count: 1 },
  { scenario: 'duplicateOrder', count: 1 },
  { scenario: 'reversedOrder', count: 1 },
  { scenario: 'uniformBot', count: 1 },
  { scenario: 'crossDay', count: 1 },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function makeId(rng, prefix) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 10; i += 1) s += alphabet[Math.floor(rng() * alphabet.length)];
  return `${prefix}_${s}`;
}

function fakeIp(rng) {
  return `${intBetween(rng, 10, 198)}.${intBetween(rng, 1, 254)}.${intBetween(rng, 1, 254)}.${intBetween(rng, 1, 254)}`;
}

export function generateDataset({ dir, from, to, timezone, seed = 20261117, sessionsPerDay = 48 }) {
  const rng = mulberry32(seed);
  const dayList = enumerateDays(from, to);
  const events = [];
  const fixtures = {
    reversalOrders: [],
    flagDevices: [],
    days: dayList,
    scenarioCounts: {},
  };

  const nextId = (prefix) => makeId(rng, prefix);

  for (const day of dayList) {
    const plan = [];
    for (const entry of DAILY_PLAN) {
      for (let i = 0; i < entry.count; i += 1) plan.push(entry.scenario);
    }
    // The cross-day session is the last session of the day so it spills into
    // the next local day, except on the final day where there is nowhere to spill.
    if (day === dayList[dayList.length - 1]) plan.splice(plan.indexOf('crossDay'), 1);
    while (plan.length < sessionsPerDay) plan.push('organic');

    for (let s = 0; s < plan.length; s += 1) {
      const scenario = plan[s];
      fixtures.scenarioCounts[scenario] = (fixtures.scenarioCounts[scenario] || 0) + 1;
      buildSession({ rng, day, timezone, scenario, nextId, events, fixtures });
    }
  }

  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id));

  mkdirSync(dir, { recursive: true });
  const batches = [];
  chunk(events, 400).forEach((list, index) => {
    const name = `batch-${String(index + 1).padStart(3, '0')}.ndjson`;
    writeBatch(join(dir, name), list);
    batches.push(name);
  });

  fixtures.flagDevices = [...new Set(fixtures.flagDevices)].slice(0, 5);
  writeFileSync(join(dir, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');

  return { dir, days: dayList, events: events.length, batches, fixtures };
}

function buildSession({ rng, day, timezone, scenario, nextId, events, fixtures }) {
  const site = pick(rng, SITES);
  const deviceId = nextId('dev');
  const sessionId = nextId('sess');
  let ip = fakeIp(rng);
  let ua = pick(rng, UAS.clean);

  if (scenario === 'headless') ua = UAS.headless;
  if (scenario === 'datacenter') ip = pick(rng, DATACENTER_IPS);

  const startTime = zonedTimeIso(
    day,
    scenario === 'crossDay'
      ? '23:58:10'
      : `${String(intBetween(rng, 7, 22)).padStart(2, '0')}:${String(intBetween(rng, 0, 55)).padStart(2, '0')}:${String(intBetween(rng, 0, 55)).padStart(2, '0')}`,
    timezone,
  );
  let cursor = Date.parse(startTime);
  const step = (seconds) => {
    cursor += seconds * 1000;
    return new Date(cursor).toISOString();
  };
  const organicStep = () => step(intBetween(rng, 5, 300));

  const base = {
    session_id: sessionId,
    site_id: site.site_id,
    device_id: deviceId,
    ip,
    country: rng() < 0.2 ? 'SG' : 'CN',
    user_agent: ua,
    referrer: 'https://demo-portal.invalid/feed',
    navigation_type: pick(rng, NAV),
  };
  const received = (occurredAt, minSeconds = 2, maxSeconds = 240) =>
    new Date(Date.parse(occurredAt) + intBetween(rng, minSeconds, maxSeconds) * 1000).toISOString();

  const push = (ev) => events.push(ev);

  const impression = (at, { viewable = 1 } = {}) => {
    const impressionId = nextId('imp');
    push({
      ...base,
      event_id: nextId('evt'),
      event_type: 'impression',
      occurred_at: at,
      received_at: received(at),
      placement_id: pick(rng, site.placements),
      viewable,
      impression_id: impressionId,
    });
    return { impressionId, occurredAt: at };
  };

  const click = (at, { impressionId, delayMs }) => {
    const clickId = nextId('clk');
    push({
      ...base,
      event_id: nextId('evt'),
      event_type: 'click',
      occurred_at: at,
      received_at: received(at, 2, 120),
      placement_id: pick(rng, site.placements),
      impression_id: impressionId,
      click_id: clickId,
      click_delay_ms: delayMs,
    });
    return { clickId, occurredAt: at };
  };

  const conversion = (at, { clickId, orderId, revenueCents }) => {
    push({
      ...base,
      event_id: nextId('evt'),
      event_type: 'conversion',
      occurred_at: at,
      received_at: received(at, 20, 3600),
      placement_id: pick(rng, site.placements),
      click_id: clickId,
      order_id: orderId,
      revenue_cents: revenueCents,
    });
  };

  // --- Plan-specific behaviour -------------------------------------------
  if (scenario === 'uniformBot') {
    // Ten impressions at a perfectly fixed 60-second cadence.
    const imps = [];
    for (let i = 0; i < 10; i += 1) imps.push(impression(i === 0 ? startTime : step(60)));
    const c = click(step(60), { impressionId: imps[0].impressionId, delayMs: 60_000 });
    return;
  }

  if (scenario === 'crossDay') {
    // Two impressions before midnight, a click after midnight. Under
    // attribution-day the click belongs to the next day; under session-day it
    // belongs to this day. The session is evaluated as one unit either way.
    const imp1 = impression(startTime);
    const imp2 = impression(step(35));
    click(step(40), { impressionId: imp2.impressionId, delayMs: 40_000 });
    void imp1;
    return;
  }

  if (scenario === 'fastClick') {
    // 55–115ms: valid under v1 (min 40ms), invalid under v2 (min 120ms).
    const imp = impression(startTime);
    const delayMs = intBetween(rng, 55, 115);
    click(new Date(Date.parse(imp.occurredAt) + delayMs + intBetween(rng, 800, 4000)).toISOString(), {
      impressionId: imp.impressionId,
      delayMs,
    });
    return;
  }

  if (scenario === 'lateClick') {
    // 20 minutes: beyond the 15-minute attribution window in both versions.
    const imp = impression(startTime);
    const at = new Date(Date.parse(imp.occurredAt) + 20 * 60 * 1000).toISOString();
    click(at, { impressionId: imp.impressionId, delayMs: 20 * 60 * 1000 });
    return;
  }

  if (scenario === 'lateConversion') {
    // 55-hour conversion: valid under v1 (72h), invalid under v2 (48h).
    const imp = impression(startTime);
    const c = click(step(30), { impressionId: imp.impressionId, delayMs: 30_000 });
    const at = new Date(Date.parse(c.occurredAt) + 55 * 3600 * 1000).toISOString();
    conversion(at, { clickId: c.clickId, orderId: nextId('ord'), revenueCents: intBetween(rng, 8_000, 60_000) });
    return;
  }

  if (scenario === 'invisibleImpression') {
    impression(startTime, { viewable: 0 });
    const imp2 = impression(organicStep());
    click(organicStep(), { impressionId: imp2.impressionId, delayMs: 45_000 });
    return;
  }

  if (scenario === 'orphanClick') {
    const imp = impression(startTime);
    // The click references an impression id that was never delivered.
    click(organicStep(), { impressionId: nextId('imp'), delayMs: 25_000 });
    void imp;
    return;
  }

  if (scenario === 'duplicateOrder') {
    const imp = impression(startTime);
    const c = click(organicStep(), { impressionId: imp.impressionId, delayMs: 40_000 });
    const orderId = nextId('ord');
    const at = new Date(Date.parse(c.occurredAt) + 10 * 60 * 1000).toISOString();
    conversion(at, { clickId: c.clickId, orderId, revenueCents: 12_000 });
    // Same order id delivered twice, 90 seconds apart.
    conversion(new Date(Date.parse(at) + 90_000).toISOString(), { clickId: c.clickId, orderId, revenueCents: 12_000 });
    return;
  }

  if (scenario === 'reversedOrder') {
    const imp = impression(startTime);
    const c = click(organicStep(), { impressionId: imp.impressionId, delayMs: 50_000 });
    const orderId = nextId('ord');
    conversion(new Date(Date.parse(c.occurredAt) + 30 * 60 * 1000).toISOString(), {
      clickId: c.clickId,
      orderId,
      revenueCents: 18_000,
    });
    if (fixtures.reversalOrders.length < 4) fixtures.reversalOrders.push(orderId);
    return;
  }

  // Organic: 1–3 impressions, 0–2 clicks, and sometimes a conversion.
  const imps = [];
  const impressionCount = intBetween(rng, 1, 3);
  for (let i = 0; i < impressionCount; i += 1) {
    imps.push(impression(i === 0 ? startTime : organicStep(), { viewable: rng() < 0.04 ? 0 : 1 }));
  }
  const clicks = [];
  const clickCount = intBetween(rng, 0, 2);
  for (let i = 0; i < clickCount; i += 1) {
    const parent = imps[i % imps.length];
    clicks.push(click(organicStep(), { impressionId: parent.impressionId, delayMs: intBetween(rng, 2, 60) * 1000 }));
  }
  if (clicks.length > 0 && rng() < 0.35) {
    const parent = clicks[0];
    conversion(new Date(Date.parse(parent.occurredAt) + intBetween(rng, 3, 20) * 60 * 60 * 1000).toISOString(), {
      clickId: parent.clickId,
      orderId: nextId('ord'),
      revenueCents: intBetween(rng, 4_000, 120_000),
    });
    if (fixtures.flagDevices.length < 12 && rng() < 0.25) fixtures.flagDevices.push(deviceId);
  }
}

function writeBatch(path, list) {
  writeFileSync(path, `${list.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function enumerateDays(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function clearDataset(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
