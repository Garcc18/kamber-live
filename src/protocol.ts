// Protocolo BLE del dispositivo KAMBER: UUIDs, tipos y (de)codificación de paquetes.
// Todos los números van en little-endian. Los codificadores se usan en los tests y en el modo demo,
// de modo que los datos simulados recorren exactamente el mismo camino que los reales.

export const DEVICE_NAME = 'KAMBER';
export const SERVICE_UUID = '6b616d62-6572-4000-8000-000000000001';
export const IMU_CHAR_UUID = '6b616d62-6572-4000-8000-000000000002';
export const ENV_CHAR_UUID = '6b616d62-6572-4000-8000-000000000003';
export const GPS_CHAR_UUID = '6b616d62-6572-4000-8000-000000000004';

export const IMU_PACKET_SIZE = 20;
export const ENV_PACKET_SIZE = 16;
export const GPS_PACKET_SIZE = 20;

export const STATUS_IMU_OK = 1 << 0;
export const STATUS_BARO_OK = 1 << 1;
export const STATUS_GPS_DATA = 1 << 2;

export type PacketKind = 'imu' | 'env' | 'gps';

export interface ImuPacket {
  /** Cuaternión (sin normalizar, tal como llega / 10000). */
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  /** Aceleración en g. */
  ax: number;
  ay: number;
  az: number;
  /** Velocidad angular en grados/s. */
  gx: number;
  gy: number;
  gz: number;
}

export interface EnvPacket {
  pressurePa: number;
  temperatureC: number;
  altitudeM: number;
  /** 0 = no medida. */
  batteryMv: number;
  status: number;
  imuOk: boolean;
  baroOk: boolean;
  gpsReceiving: boolean;
}

export interface GpsPacket {
  lat: number;
  lon: number;
  altM: number;
  speedKmh: number;
  courseDeg: number;
  /** 0 = sin posición, 1 = GPS, 2 = DGPS. */
  fix: number;
  satellites: number;
  /** Hora UTC como número hhmmss (p. ej. 142530). */
  utc: number;
}

export type Packet = ImuPacket | EnvPacket | GpsPacket;

export class PacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

type BinaryInput = DataView | ArrayBuffer | ArrayBufferView;

function toView(data: BinaryInput): DataView {
  if (data instanceof DataView) return data;
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  return new DataView(data);
}

function checkSize(dv: DataView, size: number, name: string): void {
  if (dv.byteLength < size) {
    throw new PacketError(`Paquete ${name} demasiado corto: ${dv.byteLength} bytes (se esperaban ${size})`);
  }
}

export function decodeImu(data: BinaryInput): ImuPacket {
  const dv = toView(data);
  checkSize(dv, IMU_PACKET_SIZE, 'IMU');
  return {
    qw: dv.getInt16(0, true) / 10000,
    qx: dv.getInt16(2, true) / 10000,
    qy: dv.getInt16(4, true) / 10000,
    qz: dv.getInt16(6, true) / 10000,
    ax: dv.getInt16(8, true) / 1000,
    ay: dv.getInt16(10, true) / 1000,
    az: dv.getInt16(12, true) / 1000,
    gx: dv.getInt16(14, true) / 10,
    gy: dv.getInt16(16, true) / 10,
    gz: dv.getInt16(18, true) / 10,
  };
}

export function decodeEnv(data: BinaryInput): EnvPacket {
  const dv = toView(data);
  checkSize(dv, ENV_PACKET_SIZE, 'ENTORNO');
  const status = dv.getUint8(14);
  return {
    pressurePa: dv.getFloat32(0, true),
    temperatureC: dv.getFloat32(4, true),
    altitudeM: dv.getFloat32(8, true),
    batteryMv: dv.getUint16(12, true),
    status,
    imuOk: (status & STATUS_IMU_OK) !== 0,
    baroOk: (status & STATUS_BARO_OK) !== 0,
    gpsReceiving: (status & STATUS_GPS_DATA) !== 0,
  };
}

export function decodeGps(data: BinaryInput): GpsPacket {
  const dv = toView(data);
  checkSize(dv, GPS_PACKET_SIZE, 'GPS');
  return {
    lat: dv.getInt32(0, true) / 1e7,
    lon: dv.getInt32(4, true) / 1e7,
    altM: dv.getInt16(8, true),
    speedKmh: dv.getUint16(10, true) / 100,
    courseDeg: dv.getUint16(12, true) / 100,
    fix: dv.getUint8(14),
    satellites: dv.getUint8(15),
    utc: dv.getUint32(16, true),
  };
}

export function decodePacket(kind: 'imu', data: BinaryInput): ImuPacket;
export function decodePacket(kind: 'env', data: BinaryInput): EnvPacket;
export function decodePacket(kind: 'gps', data: BinaryInput): GpsPacket;
export function decodePacket(kind: PacketKind, data: BinaryInput): Packet;
export function decodePacket(kind: PacketKind, data: BinaryInput): Packet {
  switch (kind) {
    case 'imu':
      return decodeImu(data);
    case 'env':
      return decodeEnv(data);
    case 'gps':
      return decodeGps(data);
  }
}

// ---------- Codificadores (tests y modo demo) ----------

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}
const i16 = (v: number) => clampInt(v, -32768, 32767);
const u16 = (v: number) => clampInt(v, 0, 65535);
const u8 = (v: number) => clampInt(v, 0, 255);
const i32 = (v: number) => clampInt(v, -2147483648, 2147483647);
const u32 = (v: number) => clampInt(v, 0, 4294967295);

export function encodeImu(p: ImuPacket): ArrayBuffer {
  const buf = new ArrayBuffer(IMU_PACKET_SIZE);
  const dv = new DataView(buf);
  [p.qw, p.qx, p.qy, p.qz].forEach((v, i) => dv.setInt16(i * 2, i16(v * 10000), true));
  [p.ax, p.ay, p.az].forEach((v, i) => dv.setInt16(8 + i * 2, i16(v * 1000), true));
  [p.gx, p.gy, p.gz].forEach((v, i) => dv.setInt16(14 + i * 2, i16(v * 10), true));
  return buf;
}

export function encodeEnv(p: Omit<EnvPacket, 'imuOk' | 'baroOk' | 'gpsReceiving'>): ArrayBuffer {
  const buf = new ArrayBuffer(ENV_PACKET_SIZE);
  const dv = new DataView(buf);
  dv.setFloat32(0, p.pressurePa, true);
  dv.setFloat32(4, p.temperatureC, true);
  dv.setFloat32(8, p.altitudeM, true);
  dv.setUint16(12, u16(p.batteryMv), true);
  dv.setUint8(14, u8(p.status));
  dv.setUint8(15, 0);
  return buf;
}

export function encodeGps(p: GpsPacket): ArrayBuffer {
  const buf = new ArrayBuffer(GPS_PACKET_SIZE);
  const dv = new DataView(buf);
  dv.setInt32(0, i32(p.lat * 1e7), true);
  dv.setInt32(4, i32(p.lon * 1e7), true);
  dv.setInt16(8, i16(p.altM), true);
  dv.setUint16(10, u16(p.speedKmh * 100), true);
  dv.setUint16(12, u16(p.courseDeg * 100), true);
  dv.setUint8(14, u8(p.fix));
  dv.setUint8(15, u8(p.satellites));
  dv.setUint32(16, u32(p.utc), true);
  return buf;
}

// ---------- Utilidades de hora UTC ----------

export function splitHhmmss(hhmmss: number): { h: number; m: number; s: number } | null {
  if (!Number.isFinite(hhmmss) || hhmmss < 0) return null;
  const n = Math.floor(hhmmss);
  const h = Math.floor(n / 10000);
  const m = Math.floor(n / 100) % 100;
  const s = n % 100;
  if (h > 23 || m > 59 || s > 60) return null;
  return { h, m, s };
}

/**
 * Convierte la hora UTC hhmmss del GPS en una fecha completa, usando `ref` (normalmente "ahora")
 * para el día. Corrige el salto de medianoche si la diferencia con `ref` supera 12 h.
 */
export function utcHhmmssToDate(hhmmss: number, ref: Date = new Date()): Date | null {
  const parts = splitHhmmss(hhmmss);
  if (!parts) return null;
  const DAY = 86_400_000;
  let t = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), parts.h, parts.m, parts.s);
  const diff = t - ref.getTime();
  if (diff > DAY / 2) t -= DAY;
  else if (diff < -DAY / 2) t += DAY;
  return new Date(t);
}

export function formatHhmmss(hhmmss: number): string {
  const p = splitHhmmss(hhmmss);
  if (!p) return '—';
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
}

/** Hora del sistema → número hhmmss UTC (usado por el modo demo). */
export function dateToUtcHhmmss(d: Date): number {
  return d.getUTCHours() * 10000 + d.getUTCMinutes() * 100 + d.getUTCSeconds();
}
