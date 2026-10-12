// Modo demo: simula un KAMBER bajando una pista de Sierra Nevada (Borreguiles → Pradollano)
// y subiendo en telecabina. Genera paquetes binarios con los mismos codificadores del protocolo,
// así que la app los procesa exactamente igual que los reales.

import { pressureFromAltitude, altitudeFromPressure } from './baro';
import { dateToUtcHhmmss, encodeEnv, encodeGps, encodeImu, STATUS_BARO_OK, STATUS_GPS_DATA, STATUS_IMU_OK, type PacketKind } from './protocol';
import { conjugate, fromEuler, multiply, rotateVector, type Quat, type Vec3 } from './quat';

// Ruta aproximada de la pista "El Río" (lat, lon, altitud m). Sirve solo para la demostración.
const DESCENT: [number, number, number][] = [
  [37.0798, -3.3812, 2660],
  [37.0812, -3.3838, 2600],
  [37.0829, -3.3851, 2530],
  [37.0846, -3.3878, 2450],
  [37.0861, -3.3901, 2380],
  [37.0878, -3.3917, 2300],
  [37.0895, -3.3938, 2220],
  [37.0912, -3.3955, 2160],
  [37.0928, -3.3968, 2110],
];

const ORIGIN_LAT = DESCENT[DESCENT.length - 1][0];
const ORIGIN_LON = DESCENT[DESCENT.length - 1][1];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const G = 9.81;
const DEG = Math.PI / 180;

interface Leg {
  /** Puntos en metros: [norte, este, altitud]. */
  pts: [number, number, number][];
  cum: number[];
  length: number;
  lift: boolean;
}

function toLocal([lat, lon, alt]: [number, number, number]): [number, number, number] {
  return [(lat - ORIGIN_LAT) * M_PER_DEG_LAT, (lon - ORIGIN_LON) * M_PER_DEG_LON, alt];
}

function makeLeg(points: [number, number, number][], lift: boolean): Leg {
  const pts = points.map(toLocal);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, length: cum[cum.length - 1], lift };
}

const LEGS: Leg[] = [
  makeLeg(DESCENT, false),
  makeLeg([DESCENT[DESCENT.length - 1], DESCENT[0]], true), // telecabina de vuelta arriba
];

function sampleLeg(leg: Leg, s: number) {
  let i = 1;
  while (i < leg.pts.length - 1 && leg.cum[i] < s) i++;
  const a = leg.pts[i - 1];
  const b = leg.pts[i];
  const segLen = leg.cum[i] - leg.cum[i - 1] || 1;
  const f = Math.max(0, Math.min(1, (s - leg.cum[i - 1]) / segLen));
  const dn = (b[0] - a[0]) / segLen;
  const de = (b[1] - a[1]) / segLen;
  return {
    n: a[0] + (b[0] - a[0]) * f,
    e: a[1] + (b[1] - a[1]) * f,
    alt: a[2] + (b[2] - a[2]) * f,
    dirN: dn,
    dirE: de,
    slope: (b[2] - a[2]) / segLen, // dh/ds
  };
}

function gauss(): number {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class DemoSource {
  running = false;

  private imuTimer: ReturnType<typeof setInterval> | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private lastT = 0;
  private elapsed = 0;

  // Estado de la simulación
  private leg = 0;
  private s = 0;
  private turnPhase = 0;
  private speed = 0; // m/s a lo largo de la pista
  private drift = 0; // deriva del rumbo (rad), como el Mahony sin magnetómetro
  private battery = 4080;
  private prevQ: Quat | null = null;
  private last = { n: 0, e: 0, alt: 2660, vN: 0, vE: 0, speed: 0, heading: 0 };

  constructor(private readonly emit: (kind: PacketKind, data: DataView) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.leg = 0;
    this.s = 0;
    this.elapsed = 0;
    this.turnPhase = 0;
    this.speed = 3;
    this.drift = 0;
    this.prevQ = null;
    this.slowTicks = 0;
    this.lastT = performance.now();
    this.imuTimer = setInterval(() => this.tickImu(), 40);
    this.slowTimer = setInterval(() => this.tickSlow(), 1000);
  }

  stop(): void {
    this.running = false;
    if (this.imuTimer) clearInterval(this.imuTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.imuTimer = this.slowTimer = null;
  }

  private tickImu(): void {
    const now = performance.now();
    const dt = Math.min(0.2, (now - this.lastT) / 1000);
    this.lastT = now;
    this.elapsed += dt;

    const leg = LEGS[this.leg];
    let rollRad: number;
    let pitchRad: number;
    let headingRad: number;
    let aLatRight = 0; // aceleración lateral hacia la derecha (m/s²)
    let vibration: number;
    let base = sampleLeg(leg, this.s);

    if (!leg.lift) {
      // Velocidad objetivo variando entre ~30 y ~55 km/h, con arranque suave.
      const target = (11.5 + 3.5 * Math.sin(this.elapsed / 9)) * Math.min(1, this.elapsed / 6 + 0.2);
      this.speed += (target - this.speed) * Math.min(1, dt * 0.6);
      this.s += this.speed * dt;

      // Virajes: desplazamiento lateral sinusoidal A·sin(φ) respecto al eje de la pista.
      const period = 4.6 + 0.6 * Math.sin(this.elapsed / 13);
      const w = (2 * Math.PI) / period;
      this.turnPhase += w * dt;
      const A = 6 * Math.min(1, this.elapsed / 8);
      const lateralVel = A * w * Math.cos(this.turnPhase); // hacia la izquierda
      const aLeft = -A * w * w * Math.sin(this.turnPhase);
      aLatRight = -aLeft;

      base = sampleLeg(leg, this.s);
      const trackHeading = Math.atan2(base.dirE, base.dirN);
      const dev = Math.atan2(lateralVel, this.speed); // izquierda positiva
      headingRad = trackHeading - dev;

      rollRad = Math.atan2(aLatRight, G) + this.chatter(1.2);
      const slopeAngle = Math.atan(-base.slope); // positiva bajando
      pitchRad = slopeAngle * Math.cos(dev) + this.chatter(0.8); // punta abajo
      vibration = 0.06 + 0.04 * Math.min(1, this.speed / 12);

      const leftN = -base.dirE;
      const leftE = base.dirN;
      const offset = A * Math.sin(this.turnPhase);
      const vN = base.dirN * this.speed + leftN * lateralVel;
      const vE = base.dirE * this.speed + leftE * lateralVel;
      this.last = {
        n: base.n + leftN * offset,
        e: base.e + leftE * offset,
        alt: base.alt,
        vN,
        vE,
        speed: Math.hypot(vN, vE),
        heading: headingRad,
      };
      if (this.s >= leg.length) this.nextLeg();
    } else {
      // Telecabina: velocidad constante, bota colgando con un ligero balanceo.
      this.speed = 6;
      this.s += this.speed * dt;
      base = sampleLeg(leg, this.s);
      headingRad = Math.atan2(base.dirE, base.dirN);
      rollRad = 4 * DEG * Math.sin(this.elapsed * 0.9);
      pitchRad = 12 * DEG + 3 * DEG * Math.sin(this.elapsed * 0.6);
      vibration = 0.01;
      this.last = {
        n: base.n, e: base.e, alt: base.alt,
        vN: base.dirN * this.speed, vE: base.dirE * this.speed, speed: this.speed, heading: headingRad,
      };
      if (this.s >= leg.length) this.nextLeg();
    }

    // Marco mundo: X norte, Y oeste, Z arriba. Rumbo horario desde el norte → yaw = −rumbo.
    this.drift += (0.4 * DEG / 60) * dt; // ~0,4°/min de deriva
    // Cuerpo: X punta, Y izquierda, Z arriba. pitch positivo (sobre Y) = punta abajo.
    const q = fromEuler(rollRad, pitchRad, -headingRad + this.drift);

    // Fuerza específica medida por el acelerómetro (en g): gravedad + aceleración lateral.
    const h = this.last.heading;
    const rightN = -Math.sin(h);
    const rightE = Math.cos(h);
    // Vector "derecha" en marco N-O-Arriba: (norte, −este, 0)
    const fWorld: Vec3 = [(aLatRight / G) * rightN, -(aLatRight / G) * rightE, 1];
    const fBody = rotateVector(conjugate(q), fWorld);

    // Velocidad angular a partir de dos orientaciones consecutivas (marco cuerpo).
    let gyro: Vec3 = [0, 0, 0];
    if (this.prevQ && dt > 0) {
      let d = multiply(conjugate(this.prevQ), q);
      if (d.w < 0) d = { w: -d.w, x: -d.x, y: -d.y, z: -d.z };
      const k = (2 / dt) * (180 / Math.PI);
      gyro = [d.x * k, d.y * k, d.z * k];
    }
    this.prevQ = q;

    const buf = encodeImu({
      qw: q.w, qx: q.x, qy: q.y, qz: q.z,
      ax: fBody[0] + vibration * gauss(),
      ay: fBody[1] + vibration * gauss(),
      az: fBody[2] + vibration * gauss(),
      gx: gyro[0] + 0.4 * gauss(),
      gy: gyro[1] + 0.4 * gauss(),
      gz: gyro[2] + 0.4 * gauss(),
    });
    this.emit('imu', new DataView(buf));
  }

  /** Vibración suave de la nieve (grados de amplitud): suma de senos, derivable sin picos. */
  private chatter(ampDeg: number): number {
    const t = this.elapsed;
    return ampDeg * DEG * (0.6 * Math.sin(t * 17.3) + 0.3 * Math.sin(t * 29.1 + 1.3) + 0.1 * Math.sin(t * 43.7 + 0.4));
  }

  private nextLeg(): void {
    this.leg = (this.leg + 1) % LEGS.length;
    this.s = 0;
    if (!LEGS[this.leg].lift) {
      this.elapsed = 0;
      this.speed = 3;
    }
  }

  private tickSlow(): void {
    const alt = this.last.alt;
    const pressure = pressureFromAltitude(alt) + 4 * gauss();
    this.battery = Math.max(3300, this.battery - 0.08);
    this.emit(
      'env',
      new DataView(
        encodeEnv({
          pressurePa: pressure,
          temperatureC: -2.5 - (alt - 2100) * 0.0065 + 0.1 * gauss(),
          altitudeM: altitudeFromPressure(pressure),
          batteryMv: this.battery,
          status: STATUS_IMU_OK | STATUS_BARO_OK | STATUS_GPS_DATA,
        }),
      ),
    );

    // Los primeros segundos, el GPS aún está buscando satélites.
    const searching = this.elapsedTotal() < 5;
    const sats = searching ? Math.min(3, Math.floor(this.elapsedTotal())) : 9 + Math.round(Math.random() * 2);
    const noiseM = 1.2;
    const lat = ORIGIN_LAT + (this.last.n + noiseM * gauss()) / M_PER_DEG_LAT;
    const lon = ORIGIN_LON + (this.last.e + noiseM * gauss()) / M_PER_DEG_LON;
    let course = (this.last.heading * 180) / Math.PI;
    course = ((course % 360) + 360) % 360;
    this.emit(
      'gps',
      new DataView(
        encodeGps({
          lat: searching ? 0 : lat,
          lon: searching ? 0 : lon,
          altM: searching ? 0 : alt + 3 * gauss(),
          speedKmh: searching ? 0 : Math.max(0, this.last.speed * 3.6 + 0.4 * gauss()),
          courseDeg: searching ? 0 : course,
          fix: searching ? 0 : 1,
          satellites: sats,
          utc: dateToUtcHhmmss(new Date()),
        }),
      ),
    );
    this.slowTicks++;
  }

  private slowTicks = 0;
  private elapsedTotal(): number {
    return this.slowTicks;
  }
}
