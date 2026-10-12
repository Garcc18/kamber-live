import { describe, expect, it } from 'vitest';
import {
  decodeEnv,
  decodeGps,
  decodeImu,
  decodePacket,
  encodeEnv,
  encodeGps,
  encodeImu,
  formatHhmmss,
  PacketError,
  utcHhmmssToDate,
} from './protocol';

// Paquetes construidos a mano, byte a byte, en little-endian.

// qw=10000 qx=-5000 qy=0 qz=2500 | ax=-12 ay=20 az=1000 mg | gx=125 gy=-300 gz=0 (×10 °/s)
const IMU_BYTES = new Uint8Array([
  0x10, 0x27, 0x78, 0xec, 0x00, 0x00, 0xc4, 0x09,
  0xf4, 0xff, 0x14, 0x00, 0xe8, 0x03,
  0x7d, 0x00, 0xd4, 0xfe, 0x00, 0x00,
]);

// presión 80000.0 Pa, temperatura -2.5 °C, altitud 2000.0 m, batería 3987 mV, estado 0b101
const ENV_BYTES = new Uint8Array([
  0x00, 0x40, 0x9c, 0x47,
  0x00, 0x00, 0x20, 0xc0,
  0x00, 0x00, 0xfa, 0x44,
  0x93, 0x0f,
  0x05,
  0x00,
]);

// lat 37.0937 lon -3.3976 alt 2105 m vel 45.67 km/h rumbo 270.50° fix 1, 9 sat, 14:25:30 UTC
const GPS_BYTES = new Uint8Array([
  0xa8, 0x0c, 0x1c, 0x16,
  0x40, 0x91, 0xf9, 0xfd,
  0x39, 0x08,
  0xd7, 0x11,
  0xaa, 0x69,
  0x01,
  0x09,
  0xc2, 0x2c, 0x02, 0x00,
]);

describe('decodeImu', () => {
  it('decodifica un paquete construido a mano', () => {
    const p = decodeImu(IMU_BYTES);
    expect(p.qw).toBeCloseTo(1.0, 6);
    expect(p.qx).toBeCloseTo(-0.5, 6);
    expect(p.qy).toBe(0);
    expect(p.qz).toBeCloseTo(0.25, 6);
    expect(p.ax).toBeCloseTo(-0.012, 6);
    expect(p.ay).toBeCloseTo(0.02, 6);
    expect(p.az).toBeCloseTo(1.0, 6);
    expect(p.gx).toBeCloseTo(12.5, 6);
    expect(p.gy).toBeCloseTo(-30.0, 6);
    expect(p.gz).toBe(0);
  });

  it('acepta un DataView con desplazamiento (como el de Web Bluetooth)', () => {
    const padded = new Uint8Array(24);
    padded.set(IMU_BYTES, 4);
    const p = decodeImu(new DataView(padded.buffer, 4, 20));
    expect(p.qx).toBeCloseTo(-0.5, 6);
  });

  it('rechaza paquetes cortos', () => {
    expect(() => decodeImu(new Uint8Array(19))).toThrow(PacketError);
  });

  it('ida y vuelta con el codificador', () => {
    const src = { qw: 0.7071, qx: 0, qy: 0.7071, qz: 0, ax: 0.123, ay: -1.5, az: 2.25, gx: -250.3, gy: 0.1, gz: 999.9 };
    const p = decodeImu(encodeImu(src));
    for (const k of Object.keys(src) as (keyof typeof src)[]) expect(p[k]).toBeCloseTo(src[k], 3);
  });

  it('el codificador satura en el rango int16', () => {
    const p = decodeImu(encodeImu({ qw: 1, qx: 0, qy: 0, qz: 0, ax: 40, ay: -40, az: 0, gx: 5000, gy: 0, gz: 0 }));
    expect(p.ax).toBeCloseTo(32.767, 3);
    expect(p.ay).toBeCloseTo(-32.768, 3);
    expect(p.gx).toBeCloseTo(3276.7, 1);
  });
});

describe('decodeEnv', () => {
  it('decodifica un paquete construido a mano', () => {
    const p = decodeEnv(ENV_BYTES);
    expect(p.pressurePa).toBe(80000);
    expect(p.temperatureC).toBe(-2.5);
    expect(p.altitudeM).toBe(2000);
    expect(p.batteryMv).toBe(3987);
    expect(p.status).toBe(5);
    expect(p.imuOk).toBe(true);
    expect(p.baroOk).toBe(false);
    expect(p.gpsReceiving).toBe(true);
  });

  it('ida y vuelta con el codificador', () => {
    const p = decodeEnv(encodeEnv({ pressurePa: 74321.5, temperatureC: 3.25, altitudeM: 2550.5, batteryMv: 0, status: 0b111 }));
    expect(p.pressurePa).toBeCloseTo(74321.5, 2);
    expect(p.batteryMv).toBe(0);
    expect(p.imuOk && p.baroOk && p.gpsReceiving).toBe(true);
  });

  it('rechaza paquetes cortos', () => {
    expect(() => decodeEnv(new ArrayBuffer(15))).toThrow(PacketError);
  });
});

describe('decodeGps', () => {
  it('decodifica un paquete construido a mano', () => {
    const p = decodeGps(GPS_BYTES);
    expect(p.lat).toBeCloseTo(37.0937, 7);
    expect(p.lon).toBeCloseTo(-3.3976, 7);
    expect(p.altM).toBe(2105);
    expect(p.speedKmh).toBeCloseTo(45.67, 6);
    expect(p.courseDeg).toBeCloseTo(270.5, 6);
    expect(p.fix).toBe(1);
    expect(p.satellites).toBe(9);
    expect(p.utc).toBe(142530);
  });

  it('decodePacket despacha por tipo', () => {
    expect(decodePacket('gps', GPS_BYTES).satellites).toBe(9);
    expect(decodePacket('imu', IMU_BYTES).az).toBeCloseTo(1, 6);
  });

  it('ida y vuelta con el codificador (altitud negativa)', () => {
    const src = { lat: -33.4489123, lon: -70.6693456, altM: -12, speedKmh: 123.45, courseDeg: 359.99, fix: 2, satellites: 14, utc: 235959 };
    const p = decodeGps(encodeGps(src));
    expect(p.lat).toBeCloseTo(src.lat, 7);
    expect(p.lon).toBeCloseTo(src.lon, 7);
    expect(p.altM).toBe(-12);
    expect(p.speedKmh).toBeCloseTo(123.45, 2);
    expect(p.courseDeg).toBeCloseTo(359.99, 2);
    expect(p.fix).toBe(2);
    expect(p.utc).toBe(235959);
  });
});

describe('hora UTC', () => {
  it('formatea hhmmss', () => {
    expect(formatHhmmss(142530)).toBe('14:25:30');
    expect(formatHhmmss(5)).toBe('00:00:05');
    expect(formatHhmmss(256000)).toBe('—');
  });

  it('convierte a fecha usando el día de referencia', () => {
    const ref = new Date(Date.UTC(2026, 0, 15, 14, 30, 0));
    expect(utcHhmmssToDate(142530, ref)?.toISOString()).toBe('2026-01-15T14:25:30.000Z');
  });

  it('corrige el salto de medianoche', () => {
    const justAfter = new Date(Date.UTC(2026, 0, 16, 0, 0, 5));
    expect(utcHhmmssToDate(235958, justAfter)?.toISOString()).toBe('2026-01-15T23:59:58.000Z');
    const justBefore = new Date(Date.UTC(2026, 0, 15, 23, 59, 58));
    expect(utcHhmmssToDate(3, justBefore)?.toISOString()).toBe('2026-01-16T00:00:03.000Z');
  });
});
