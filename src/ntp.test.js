import { test, expect } from "bun:test";

import {
  NTP_EPOCH_OFFSET_SECONDS,
  buildRequestPacket,
  computeOffset,
  parseResponsePacket,
  toSocketError,
  toUnixMs,
} from "./ntp.js";

/**
 * Baut eine Serverantwort zum Testen - ohne Netzwerk.
 *
 * @param {{ mode?: number, version?: number, leap?: number, stratum?: number,
 *           receiveSeconds?: number, receiveFraction?: number,
 *           transmitSeconds?: number, transmitFraction?: number,
 *           referenceId?: string, size?: number }} [options]
 */
function buildResponsePacket({
  mode = 4,
  version = 4,
  leap = 0,
  stratum = 2,
  receiveSeconds = NTP_EPOCH_OFFSET_SECONDS + 1_000,
  receiveFraction = 0,
  transmitSeconds = NTP_EPOCH_OFFSET_SECONDS + 1_000,
  transmitFraction = 0,
  referenceId = "",
  size = 48,
} = {}) {
  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  view.setUint8(0, (leap << 6) | (version << 3) | mode);
  view.setUint8(1, stratum);
  for (let i = 0; i < referenceId.length && i < 4; i += 1) {
    view.setUint8(12 + i, referenceId.charCodeAt(i));
  }
  if (size >= 48) {
    view.setUint32(32, receiveSeconds);
    view.setUint32(36, receiveFraction);
    view.setUint32(40, transmitSeconds);
    view.setUint32(44, transmitFraction);
  }
  return packet;
}

test("buildRequestPacket liefert 48 Byte mit Mode 3 und Version 4", () => {
  const packet = buildRequestPacket();

  expect(packet).toBeInstanceOf(Uint8Array);
  expect(packet.byteLength).toBe(48);
  expect(packet[0]).toBe(0x23);
  expect(packet[0] & 0b111).toBe(3);
  expect((packet[0] >> 3) & 0b111).toBe(4);
  expect(Array.from(packet.slice(1)).every((byte) => byte === 0)).toBe(true);
});

test("toUnixMs rechnet NTP-Timestamps in Unix-Millisekunden um", () => {
  expect(toUnixMs(NTP_EPOCH_OFFSET_SECONDS, 0)).toBe(0);
  expect(toUnixMs(NTP_EPOCH_OFFSET_SECONDS + 1, 0)).toBe(1000);
  expect(toUnixMs(NTP_EPOCH_OFFSET_SECONDS, 2 ** 31)).toBeCloseTo(500, 6);
});

test("parseResponsePacket zerlegt eine gueltige Antwort", () => {
  // 2026-10-14T17:14:50.000Z
  const unixSeconds = Math.floor(Date.UTC(2026, 9, 14, 17, 14, 50) / 1000);
  const packet = buildResponsePacket({
    stratum: 3,
    leap: 0,
    receiveSeconds: NTP_EPOCH_OFFSET_SECONDS + unixSeconds,
    receiveFraction: 2 ** 31, // 500 ms
    transmitSeconds: NTP_EPOCH_OFFSET_SECONDS + unixSeconds,
    transmitFraction: 2 ** 30, // 250 ms
  });

  const parsed = parseResponsePacket(packet);

  expect(parsed.mode).toBe(4);
  expect(parsed.versionNumber).toBe(4);
  expect(parsed.leapIndicator).toBe(0);
  expect(parsed.stratum).toBe(3);
  expect(parsed.receiveTimestamp).toBeCloseTo(unixSeconds * 1000 + 500, 6);
  expect(parsed.transmitTimestamp).toBeCloseTo(unixSeconds * 1000 + 250, 6);
  expect(new Date(Math.round(parsed.transmitTimestamp)).toISOString()).toBe("2026-10-14T17:14:50.250Z");
});

test("parseResponsePacket liest auch aus einem View mit byteOffset", () => {
  const packet = buildResponsePacket();
  const padded = new Uint8Array(64);
  padded.set(packet, 8);
  const view = padded.subarray(8, 56);

  expect(parseResponsePacket(view).stratum).toBe(2);
});

test("parseResponsePacket lehnt eine falsche Paketlaenge ab", () => {
  expect(() => parseResponsePacket(buildResponsePacket({ size: 32 }))).toThrow(/32 Byte/);
  expect(() => parseResponsePacket(undefined)).toThrow(/0 Byte/);
});

test("parseResponsePacket lehnt einen falschen Mode ab", () => {
  expect(() => parseResponsePacket(buildResponsePacket({ mode: 3 }))).toThrow(/Mode 3/);
});

test("parseResponsePacket meldet Kiss-of-Death mit Code", () => {
  const packet = buildResponsePacket({ stratum: 0, referenceId: "RATE" });

  expect(() => parseResponsePacket(packet)).toThrow(/Kiss-of-Death/);
  expect(() => parseResponsePacket(packet)).toThrow(/RATE/);
});

test("parseResponsePacket lehnt ein zu hohes Stratum ab", () => {
  expect(() => parseResponsePacket(buildResponsePacket({ stratum: 16 }))).toThrow(/Stratum 16/);
});

test("parseResponsePacket lehnt eine Antwort ohne Transmit-Timestamp ab", () => {
  const packet = buildResponsePacket({ transmitSeconds: 0, transmitFraction: 0 });

  expect(() => parseResponsePacket(packet)).toThrow(/Transmit-Timestamp/);
});

test("computeOffset rechnet Offset und Roundtrip nach RFC 5905", () => {
  expect(computeOffset({ t1: 0, t2: 100, t3: 100, t4: 20 })).toEqual({
    offsetMs: 90,
    roundtripMs: 20,
  });
});

test("computeOffset liefert Offset 0 bei synchroner Uhr", () => {
  // Hinweg und Rueckweg je 10 ms, Serveruhr identisch zur Clientuhr.
  expect(computeOffset({ t1: 1000, t2: 1010, t3: 1010, t4: 1020 })).toEqual({
    offsetMs: 0,
    roundtripMs: 20,
  });
});

test("toSocketError findet den Fehler, egal an welcher Position er steht", () => {
  const failure = new Error("ENETUNREACH: network is unreachable, recv");

  // So ruft Bun 1.4 den Handler auf: nur der Fehler.
  expect(toSocketError([failure], "ntp.example (203.0.113.7)")).toBe(failure);
  // So verspricht es die Typdefinition: (socket, error).
  expect(toSocketError([{ close() {} }, failure], "ntp.example (203.0.113.7)")).toBe(failure);
});

test("toSocketError fuellt eine Meldung, wenn kein Fehler mitkommt", () => {
  const error = toSocketError([undefined], "ntp.example (203.0.113.7)");

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("ntp.example (203.0.113.7)");
});
