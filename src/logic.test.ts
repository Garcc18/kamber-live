import { describe, expect, it } from 'vitest';
import {
  AXIS_SOURCES,
  DEFAULT_THREE_MAP,
  IDENTITY_MAP,
  applyMapToQuat,
  applyMapToVector,
  composeMaps,
  conjugate,
  describeMap,
  displayAngles,
  fromEuler,
  invertMap,
  isValidMap,
  mapDeterminant,
  multiply,
  rotateVector,
  toEuler,
  type AxisMap,
  type Quat,
  type Vec3,
} from './quat';
import { AlphaBetaFilter, BaroProcessor, ElevationAccumulator, altitudeFromPressure, pressureFromAltitude } from './baro';
import { Recorder, toCsv, toGpx, CSV_COLUMNS } from './recorder';
import type { EnvPacket } from './protocol';

const deg = Math.PI / 180;

function expectVec(a: Vec3, b: Vec3, digits = 6) {
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

describe('cuaterniones', () => {
  it('Euler ida y vuelta', () => {
    const q = fromEuler(20 * deg, -35 * deg, 120 * deg);
    const e = toEuler(q);
    expect(e.roll / deg).toBeCloseTo(20, 6);
    expect(e.pitch / deg).toBeCloseTo(-35, 6);
    expect(e.yaw / deg).toBeCloseTo(120, 6);
  });

  it('signos de los ángulos mostrados', () => {
    // Lado izquierdo (Y+) hacia arriba → inclinado a la derecha → roll positivo.
    expect(displayAngles(fromEuler(30 * deg, 0, 0)).roll).toBeCloseTo(30, 6);
    // Rotación positiva sobre Y baja la punta → se muestra cabeceo negativo.
    const qDown = fromEuler(0, 10 * deg, 0);
    expect(rotateVector(qDown, [1, 0, 0])[2]).toBeLessThan(0);
    expect(displayAngles(qDown).pitch).toBeCloseTo(-10, 6);
    // Rotación positiva sobre Z (izquierda) → rumbo negativo.
    expect(displayAngles(fromEuler(0, 0, 15 * deg)).yaw).toBeCloseTo(-15, 6);
  });

  it('tara: q_ref⁻¹ · q da la identidad en la referencia', () => {
    const q = fromEuler(0.3, 0.2, 1.1);
    const rel = multiply(conjugate(q), q);
    expect(rel.w).toBeCloseTo(1, 9);
  });
});

describe('remapeo de ejes', () => {
  const allMaps: AxisMap[] = [];
  for (const x of AXIS_SOURCES) for (const y of AXIS_SOURCES) for (const z of AXIS_SOURCES) {
    const m = { x, y, z };
    if (isValidMap(m)) allMaps.push(m);
  }

  it('hay 48 combinaciones válidas', () => {
    expect(allMaps.length).toBe(48);
    expect(isValidMap({ x: '+x', y: '-x', z: '+z' })).toBe(false);
  });

  it('la conversión por defecto es (x: qx, y: qz, z: −qy) y es una rotación', () => {
    expect(describeMap(DEFAULT_THREE_MAP)).toBe('x: qx, y: qz, z: −qy');
    expect(mapDeterminant(DEFAULT_THREE_MAP)).toBe(1);
    const q: Quat = { w: 0.5, x: 0.1, y: 0.2, z: 0.3 };
    expect(applyMapToQuat(DEFAULT_THREE_MAP, q)).toEqual({ w: 0.5, x: 0.1, y: 0.3, z: -0.2 });
    // El Z del sensor (arriba) acaba en el Y de three.js (arriba).
    expectVec(applyMapToVector(DEFAULT_THREE_MAP, [0, 0, 1]), [0, 1, 0]);
  });

  it('el cuaternión remapeado rota igual que el original en el nuevo marco (incluido con reflejo)', () => {
    const q = fromEuler(0.4, -0.7, 2.0);
    const v: Vec3 = [0.3, -1.2, 0.8];
    for (const m of allMaps) {
      const qm = applyMapToQuat(m, q);
      // M(q·v) == q'·(M v)
      expectVec(applyMapToVector(m, rotateVector(q, v)), rotateVector(qm, applyMapToVector(m, v)));
    }
  });

  it('inversa y composición', () => {
    for (const m of allMaps) {
      expect(composeMaps(invertMap(m), m)).toEqual(IDENTITY_MAP);
      expect(composeMaps(m, invertMap(m))).toEqual(IDENTITY_MAP);
    }
    const a: AxisMap = { x: '-y', y: '+z', z: '-x' };
    const v: Vec3 = [1, 2, 3];
    expectVec(applyMapToVector(composeMaps(a, DEFAULT_THREE_MAP), v), applyMapToVector(a, applyMapToVector(DEFAULT_THREE_MAP, v)));
  });
});

describe('barómetro', () => {
  const env = (alt: number): EnvPacket => ({
    pressurePa: pressureFromAltitude(alt), temperatureC: 0, altitudeM: alt, batteryMv: 0, status: 7,
    imuOk: true, baroOk: true, gpsReceiving: true,
  });

  it('ISA ida y vuelta', () => {
    expect(altitudeFromPressure(pressureFromAltitude(2500))).toBeCloseTo(2500, 0);
    expect(pressureFromAltitude(0)).toBeCloseTo(101325, 0);
  });

  it('el filtro alfa-beta converge a la velocidad de una rampa', () => {
    const f = new AlphaBetaFilter();
    let r = { x: 0, v: 0 };
    for (let i = 0; i < 80; i++) r = f.update(1000 + 1.5 * i, 1);
    expect(r.v).toBeCloseTo(1.5, 2);
  });

  it('el desnivel ignora ruido pequeño', () => {
    const acc = new ElevationAccumulator(2);
    for (const a of [100, 101, 99.5, 100.8, 99.2, 100.4]) acc.update(a);
    expect(acc.gain).toBe(0);
    expect(acc.loss).toBe(0);
    for (const a of [103, 106, 110, 104, 98]) acc.update(a);
    expect(acc.gain).toBeCloseTo(10, 6);
    expect(acc.loss).toBeCloseTo(12, 6);
  });

  it('procesador: cero relativo, velocidad vertical y desnivel', () => {
    const b = new BaroProcessor();
    for (let i = 0; i < 30; i++) b.update(env(2000), i);
    b.setZero();
    for (let i = 30; i < 130; i++) b.update(env(2000 - 2 * (i - 30)), i);
    const s = b.state!;
    expect(s.verticalSpeed).toBeCloseTo(-2, 1);
    expect(s.relativeM!).toBeLessThan(-190);
    expect(s.lossM).toBeGreaterThan(190);
    expect(s.gainM).toBe(0);
    b.resetSession();
    expect(b.state!.lossM).toBe(0);
  });

  it('ignora paquetes con el barómetro en error', () => {
    const b = new BaroProcessor();
    expect(b.update({ ...env(1000), baroOk: false }, 0)).toBeNull();
  });
});

describe('grabación', () => {
  const rec = new Recorder();
  const t0 = Date.UTC(2026, 1, 3, 10, 0, 0);
  rec.start(t0);
  rec.add({ t: t0, kind: 'imu', p: { qw: 1, qx: 0, qy: 0, qz: 0, ax: 0, ay: 0, az: 1, gx: 1.5, gy: 0, gz: 0 } });
  rec.add({ t: t0 + 40, kind: 'env', p: { pressurePa: 75000.25, temperatureC: -3.5, altitudeM: 2450.5, batteryMv: 3900, status: 7, imuOk: true, baroOk: true, gpsReceiving: true } });
  rec.add({ t: t0 + 1000, kind: 'gps', p: { lat: 37.1, lon: -3.39, altM: 2400, speedKmh: 30.5, courseDeg: 90, fix: 0, satellites: 3, utc: 100001 } });
  rec.add({ t: t0 + 2000, kind: 'gps', p: { lat: 37.0937, lon: -3.3976, altM: 2105, speedKmh: 45.5, courseDeg: 270, fix: 1, satellites: 9, utc: 100002 } });
  rec.stop(t0 + 2500);

  it('cuenta paquetes y duración', () => {
    expect(rec.counts).toEqual({ imu: 1, env: 1, gps: 2 });
    expect(rec.durationMs()).toBe(2500);
    expect(rec.gpsFixCount).toBe(1);
  });

  it('no graba si está parado', () => {
    rec.add({ t: t0 + 3000, kind: 'imu', p: { qw: 1, qx: 0, qy: 0, qz: 0, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 } });
    expect(rec.rows.length).toBe(4);
  });

  it('CSV: cabecera y una fila por paquete con columnas alineadas', () => {
    const lines = toCsv(rec.rows).trim().split('\r\n');
    expect(lines.length).toBe(5);
    expect(lines[0].split(',')).toEqual([...CSV_COLUMNS]);
    for (const l of lines) expect(l.split(',').length).toBe(CSV_COLUMNS.length);
    const env = lines[2].split(',');
    expect(env[0]).toBe('0.040');
    expect(env[2]).toBe('entorno');
    expect(env[CSV_COLUMNS.indexOf('presion_pa')]).toBe('75000.3');
    expect(env[CSV_COLUMNS.indexOf('qw')]).toBe('');
    expect(lines[4].split(',')[CSV_COLUMNS.indexOf('hora_utc')]).toBe('100002');
  });

  it('CSV con punto y coma usa coma decimal', () => {
    const lines = toCsv(rec.rows, ';').trim().split('\r\n');
    for (const l of lines) expect(l.split(';').length).toBe(CSV_COLUMNS.length);
    expect(lines[2].split(';')[CSV_COLUMNS.indexOf('temperatura_c')]).toBe('-3,50');
  });

  it('GPX solo con puntos con fix', () => {
    const gpx = toGpx(rec.rows, 'Prueba <1>');
    expect(gpx.match(/<trkpt/g)?.length).toBe(1);
    expect(gpx).toContain('lat="37.0937000" lon="-3.3976000"');
    expect(gpx).toContain('<time>2026-02-03T10:00:02.000Z</time>');
    expect(gpx).toContain('Prueba &lt;1&gt;');
  });
});
