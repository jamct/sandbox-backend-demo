/**
 * Route-Handler fuer GET /time samt Offset-Cache.
 *
 * Ein NTP-Sync versorgt viele HTTP-Requests: zwischen zwei Syncs wird die Zeit
 * aus der lokalen Uhr plus gemessenem Offset abgeleitet. Das ist das uebliche
 * SNTP-Vorgehen und schuetzt den Zeitserver vor einem Paket pro Request.
 */

import { queryNtp } from "./ntp.js";

const DEFAULT_SERVER = "pool.ntp.org";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_MS = 60_000;

/**
 * Eine NTP-Abfrage, wie `queryNtp` sie umsetzt. Als eigener Typ, damit Tests
 * eine eigene Implementierung einsetzen koennen.
 *
 * @typedef {(options: { host: string, timeoutMs: number }) => Promise<{
 *   offsetMs: number,
 *   roundtripMs: number,
 *   stratum: number,
 *   server?: string,
 *   address?: string,
 * }>} NtpQuery
 */

/**
 * @typedef {object} NtpSyncState
 * @property {number} offsetMs Differenz Serveruhr minus lokale Uhr.
 * @property {number} roundtripMs Gemessene Paketumlaufzeit.
 * @property {number} stratum Stratum des antwortenden Servers.
 * @property {string} server Abgefragter Hostname.
 * @property {string} [address] Aufgeloeste IP-Adresse.
 * @property {number} syncedAtMs Lokale Zeit des letzten erfolgreichen Syncs.
 */

/**
 * @param {number} value
 * @returns {number} auf drei Nachkommastellen gerundet
 */
function roundMs(value) {
  return Number(value.toFixed(3));
}

/**
 * Baut den Handler fuer GET /time. Die Abhaengigkeiten sind Parameter, damit
 * Tests ohne Netzwerk und ohne echte Uhr laufen koennen.
 *
 * @param {{
 *   query?: NtpQuery,
 *   server?: string,
 *   timeoutMs?: number,
 *   cacheMs?: number,
 *   now?: () => number,
 * }} [options]
 * @returns {() => Promise<Response>}
 */
export function createTimeHandler({
  query = queryNtp,
  server = Bun.env.NTP_SERVER ?? DEFAULT_SERVER,
  timeoutMs = Number(Bun.env.NTP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  cacheMs = Number(Bun.env.NTP_CACHE_MS ?? DEFAULT_CACHE_MS),
  now = () => Date.now(),
} = {}) {
  /** @type {NtpSyncState | null} */
  let sync = null;
  /** @type {Promise<NtpSyncState> | null} */
  let inFlight = null;

  /**
   * @returns {NtpSyncState | null} der gecachte Sync, solange er frisch ist
   */
  function freshSync() {
    if (sync !== null && now() - sync.syncedAtMs < cacheMs) {
      return sync;
    }
    return null;
  }

  /**
   * @returns {Promise<NtpSyncState>}
   */
  function getSync() {
    const cached = freshSync();
    if (cached !== null) {
      return Promise.resolve(cached);
    }

    // Laufende Abfrage teilen, damit eine Lastspitze nicht n Pakete ausloest.
    if (inFlight === null) {
      inFlight = query({ host: server, timeoutMs })
        .then((result) => {
          /** @type {NtpSyncState} */
          const state = {
            offsetMs: result.offsetMs,
            roundtripMs: result.roundtripMs,
            stratum: result.stratum,
            server: result.server ?? server,
            address: result.address,
            syncedAtMs: now(),
          };
          sync = state;
          return state;
        })
        .finally(() => {
          inFlight = null;
        });
    }

    return inFlight;
  }

  return async function handleTime() {
    try {
      const state = await getSync();
      const unixMs = Math.round(now() + state.offsetMs);

      return Response.json({
        iso: new Date(unixMs).toISOString(),
        unixMs,
        source: "ntp",
        server: state.server,
        stratum: state.stratum,
        offsetMs: roundMs(state.offsetMs),
        roundtripMs: roundMs(state.roundtripMs),
        syncedAt: new Date(state.syncedAtMs).toISOString(),
      });
    } catch (error) {
      // Fehler werden nicht gecacht: der naechste Request versucht es erneut.
      return Response.json(
        { error: "ntp_unavailable", detail: error instanceof Error ? error.message : String(error) },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}
