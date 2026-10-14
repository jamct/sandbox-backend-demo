/**
 * SNTP-Client (NTP-Protokoll, RFC 5905/4330) auf Basis von Bun-APIs.
 *
 * Die reinen Funktionen (Paket bauen, Paket parsen, Offset rechnen) sind vom
 * UDP-Teil getrennt, damit sie ohne Netzwerk testbar sind.
 */

/** Sekunden zwischen der NTP-Epoche (1900-01-01) und der Unix-Epoche (1970-01-01). */
export const NTP_EPOCH_OFFSET_SECONDS = 2_208_988_800;

const PACKET_SIZE = 48;
const MODE_SERVER = 4;
const MAX_STRATUM = 15;
const OFFSET_REFERENCE_ID = 12;
const OFFSET_RECEIVE_TIMESTAMP = 32;
const OFFSET_TRANSMIT_TIMESTAMP = 40;

/**
 * Baut ein leeres Client-Request-Paket: 48 Byte, nur das erste Byte ist gesetzt.
 *
 * @returns {Uint8Array}
 */
export function buildRequestPacket() {
  const packet = new Uint8Array(PACKET_SIZE);
  // 0x23 = LI 0 (kein Leap Warning), Version 4, Mode 3 (Client).
  packet[0] = 0x23;
  return packet;
}

/**
 * Rechnet einen NTP-Timestamp (32 Bit Sekunden + 32 Bit Fraktion) in
 * Unix-Millisekunden um.
 *
 * @param {number} seconds
 * @param {number} fraction
 * @returns {number}
 */
export function toUnixMs(seconds, fraction) {
  return (seconds - NTP_EPOCH_OFFSET_SECONDS) * 1000 + (fraction / 2 ** 32) * 1000;
}

/**
 * @param {DataView} view
 * @param {number} byteOffset
 */
function readTimestamp(view, byteOffset) {
  return toUnixMs(view.getUint32(byteOffset), view.getUint32(byteOffset + 4));
}

/**
 * Liest den Reference Identifier als ASCII - bei Stratum 0 steht dort der
 * Kiss-Code, z. B. "RATE" oder "DENY".
 *
 * @param {DataView} view
 */
function readKissCode(view) {
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    const byte = view.getUint8(OFFSET_REFERENCE_ID + i);
    code += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "";
  }
  return code;
}

/**
 * Prueft und zerlegt eine NTP-Serverantwort.
 *
 * @param {Uint8Array | undefined} bytes
 * @returns {{ leapIndicator: number, versionNumber: number, mode: number,
 *             stratum: number, receiveTimestamp: number, transmitTimestamp: number }}
 */
export function parseResponsePacket(bytes) {
  if (!bytes || bytes.byteLength !== PACKET_SIZE) {
    const byteLength = bytes?.byteLength ?? 0;
    throw new Error(`NTP-Antwort ist ${byteLength} Byte lang, erwartet werden ${PACKET_SIZE}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstByte = view.getUint8(0);
  const leapIndicator = firstByte >> 6;
  const versionNumber = (firstByte >> 3) & 0b111;
  const mode = firstByte & 0b111;
  const stratum = view.getUint8(1);

  if (mode !== MODE_SERVER) {
    throw new Error(`NTP-Antwort hat Mode ${mode}, erwartet wird ${MODE_SERVER} (Server)`);
  }
  if (stratum === 0) {
    throw new Error(`NTP-Server antwortet mit Kiss-of-Death (Stratum 0, Code "${readKissCode(view)}")`);
  }
  if (stratum > MAX_STRATUM) {
    throw new Error(`NTP-Antwort hat ungueltiges Stratum ${stratum}`);
  }
  if (view.getUint32(OFFSET_TRANSMIT_TIMESTAMP) === 0 && view.getUint32(OFFSET_TRANSMIT_TIMESTAMP + 4) === 0) {
    throw new Error("NTP-Antwort hat keinen Transmit-Timestamp");
  }

  return {
    leapIndicator,
    versionNumber,
    mode,
    stratum,
    receiveTimestamp: readTimestamp(view, OFFSET_RECEIVE_TIMESTAMP),
    transmitTimestamp: readTimestamp(view, OFFSET_TRANSMIT_TIMESTAMP),
  };
}

/**
 * Offset- und Roundtrip-Formel aus RFC 5905.
 *
 * @param {{ t1: number, t2: number, t3: number, t4: number }} timestamps
 *   t1 = Abgang beim Client, t2 = Ankunft beim Server,
 *   t3 = Abgang beim Server, t4 = Ankunft beim Client.
 * @returns {{ offsetMs: number, roundtripMs: number }}
 */
export function computeOffset({ t1, t2, t3, t4 }) {
  return {
    offsetMs: (t2 - t1 + (t3 - t4)) / 2,
    roundtripMs: t4 - t1 - (t3 - t2),
  };
}

/**
 * Holt den Fehler aus den Argumenten des UDP-`error`-Handlers.
 *
 * Bun ruft den Handler zur Laufzeit mit nur einem Argument auf (dem Fehler,
 * z. B. "ENETUNREACH: network is unreachable, recv"), waehrend die
 * Typdefinition `(socket, error)` verspricht. Diese Funktion kommt mit beiden
 * Formen zurecht, statt sich auf eine Position zu verlassen.
 *
 * @param {unknown[]} args
 * @param {string} description Server fuer die Fallback-Meldung
 * @returns {Error}
 */
export function toSocketError(args, description) {
  const failure = args.find((arg) => arg instanceof Error);
  if (failure instanceof Error) {
    return failure;
  }
  return new Error(`UDP-Fehler bei der Abfrage von ${description}`);
}

/**
 * Fragt einen NTP-Server per UDP ab.
 *
 * @param {{ host?: string, port?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ timeMs: number, offsetMs: number, roundtripMs: number,
 *                     stratum: number, server: string, address: string }>}
 */
export async function queryNtp({ host, port = 123, timeoutMs = 3000 } = {}) {
  if (!host) {
    throw new Error('queryNtp: "host" fehlt');
  }

  // Bun.udpSocket#send erwartet eine IP-Adresse, keinen Hostnamen.
  const [resolved] = await Bun.dns.lookup(host, { family: 4 });
  if (!resolved) {
    throw new Error(`Hostname "${host}" liess sich nicht aufloesen`);
  }
  const address = resolved.address;

  /** @type {(value: { data: Uint8Array, t4: number }) => void} */
  let onResponse;
  /** @type {(reason: Error) => void} */
  let onFailure;
  const answer = new Promise((resolve, reject) => {
    onResponse = resolve;
    onFailure = reject;
  });

  const socket = await Bun.udpSocket({
    socket: {
      data(_socket, data) {
        onResponse({ data, t4: Date.now() });
      },
      error(...args) {
        onFailure(toSocketError(args, `${host} (${address})`));
      },
    },
  });

  const timer = setTimeout(() => {
    onFailure(new Error(`NTP-Server ${host} (${address}) hat nicht innerhalb von ${timeoutMs} ms geantwortet`));
  }, timeoutMs);

  try {
    const t1 = Date.now();
    socket.send(buildRequestPacket(), port, address);
    const { data, t4 } = await answer;
    const packet = parseResponsePacket(data);
    const { offsetMs, roundtripMs } = computeOffset({
      t1,
      t2: packet.receiveTimestamp,
      t3: packet.transmitTimestamp,
      t4,
    });

    return {
      timeMs: Date.now() + offsetMs,
      offsetMs,
      roundtripMs,
      stratum: packet.stratum,
      server: host,
      address,
    };
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
