import { test, expect } from "bun:test";

import { createTimeHandler } from "./time.js";

/**
 * @param {Response} response
 * @returns {Promise<any>} der geparste JSON-Body
 */
function json(response) {
  return response.json();
}

/**
 * Baut eine Fake-Uhr und eine Fake-NTP-Abfrage, damit die Tests ohne Netz und
 * ohne echte Zeit laufen.
 *
 * @param {{ offsetMs?: number, startMs?: number, delayMs?: number, fail?: boolean }} [options]
 */
function createHarness({ offsetMs = 250, startMs = 1_760_000_000_000, delayMs = 0, fail = false } = {}) {
  let currentMs = startMs;
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    now: () => currentMs,
    /** @param {number} ms */
    advance(ms) {
      currentMs += ms;
    },
    /** @param {{ host: string, timeoutMs?: number }} options */
    async query({ host }) {
      calls += 1;
      if (delayMs > 0) {
        await Bun.sleep(delayMs);
      }
      if (fail) {
        throw new Error("Zeitserver nicht erreichbar");
      }
      return {
        timeMs: currentMs + offsetMs,
        offsetMs,
        roundtripMs: 12.3456,
        stratum: 2,
        server: host,
        address: "203.0.113.7",
      };
    },
  };
}

test("GET /time liefert die per NTP ermittelte Zeit", async () => {
  const harness = createHarness({ offsetMs: 250 });
  const handler = createTimeHandler({
    query: harness.query,
    now: harness.now,
    server: "ntp.example",
    cacheMs: 60_000,
  });

  const response = await handler();
  const body = await json(response);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(body).toEqual({
    iso: new Date(harness.now() + 250).toISOString(),
    unixMs: harness.now() + 250,
    source: "ntp",
    server: "ntp.example",
    stratum: 2,
    offsetMs: 250,
    roundtripMs: 12.346,
    syncedAt: new Date(harness.now()).toISOString(),
  });
  expect(new Date(body.iso).getTime()).toBe(body.unixMs);
});

test("innerhalb der Cache-Zeit wird nur einmal synchronisiert", async () => {
  const harness = createHarness({ offsetMs: 100 });
  const handler = createTimeHandler({ query: harness.query, now: harness.now, cacheMs: 60_000 });

  const first = await json(await handler());
  harness.advance(5_000);
  const second = await json(await handler());

  expect(harness.calls).toBe(1);
  expect(second.syncedAt).toBe(first.syncedAt);
  // Zeit laeuft zwischen zwei Syncs aus der lokalen Uhr plus Offset weiter.
  expect(second.unixMs - first.unixMs).toBe(5_000);
});

test("nach Ablauf der Cache-Zeit wird neu synchronisiert", async () => {
  const harness = createHarness();
  const handler = createTimeHandler({ query: harness.query, now: harness.now, cacheMs: 60_000 });

  await handler();
  harness.advance(60_001);
  const second = await json(await handler());

  expect(harness.calls).toBe(2);
  expect(second.syncedAt).toBe(new Date(harness.now()).toISOString());
});

test("cacheMs 0 synchronisiert bei jedem Request", async () => {
  const harness = createHarness();
  const handler = createTimeHandler({ query: harness.query, now: harness.now, cacheMs: 0 });

  await handler();
  await handler();

  expect(harness.calls).toBe(2);
});

test("parallele Requests teilen eine laufende Abfrage", async () => {
  const harness = createHarness({ delayMs: 20 });
  const handler = createTimeHandler({ query: harness.query, now: harness.now, cacheMs: 60_000 });

  const responses = await Promise.all([handler(), handler()]);

  expect(harness.calls).toBe(1);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
});

test("ohne erreichbaren Zeitserver antwortet /time mit 503", async () => {
  const harness = createHarness({ fail: true });
  const handler = createTimeHandler({ query: harness.query, now: harness.now, cacheMs: 60_000 });

  const response = await handler();
  const body = await json(response);

  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.error).toBe("ntp_unavailable");
  expect(body.detail).toContain("nicht erreichbar");
});

test("ein Fehler wird nicht gecacht - der naechste Request versucht es erneut", async () => {
  const harness = createHarness({ fail: true });
  const handler = createTimeHandler({ query: harness.query, now: harness.now, cacheMs: 60_000 });

  await handler();
  await handler();

  expect(harness.calls).toBe(2);
});
