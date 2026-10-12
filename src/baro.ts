// Procesado del barómetro: altitud relativa, velocidad vertical filtrada y desnivel acumulado.

import type { EnvPacket } from './protocol';

/**
 * Filtro alfa-beta (g-h): estima posición y velocidad a partir de medidas ruidosas de posición.
 * Con muestras a 1 Hz, alpha≈0.3 y beta≈0.05 dan una velocidad vertical estable sin demasiado retraso.
 */
export class AlphaBetaFilter {
  x = 0;
  v = 0;
  initialized = false;

  constructor(
    public alpha = 0.3,
    public beta = 0.05,
  ) {}

  reset(x?: number): void {
    this.initialized = x !== undefined;
    this.x = x ?? 0;
    this.v = 0;
  }

  update(z: number, dt: number): { x: number; v: number } {
    if (!this.initialized || !(dt > 0)) {
      this.reset(z);
      return { x: this.x, v: this.v };
    }
    const xPred = this.x + this.v * dt;
    const r = z - xPred;
    this.x = xPred + this.alpha * r;
    this.v = this.v + (this.beta / dt) * r;
    return { x: this.x, v: this.v };
  }
}

/**
 * Desnivel acumulado con histéresis: solo cuenta un tramo cuando la altitud se aleja más de
 * `threshold` metros de la última referencia, para no sumar el ruido del sensor.
 */
export class ElevationAccumulator {
  gain = 0;
  loss = 0;
  private ref: number | null = null;

  constructor(public threshold = 2) {}

  reset(current?: number): void {
    this.gain = 0;
    this.loss = 0;
    this.ref = current ?? null;
  }

  update(alt: number): void {
    if (this.ref === null) {
      this.ref = alt;
      return;
    }
    const d = alt - this.ref;
    if (d >= this.threshold) {
      this.gain += d;
      this.ref = alt;
    } else if (-d >= this.threshold) {
      this.loss += -d;
      this.ref = alt;
    }
  }
}

export interface BaroState {
  pressureHpa: number;
  temperatureC: number;
  altitudeM: number;
  /** Altitud filtrada (m). */
  filteredAltM: number;
  /** Altitud relativa al cero (m); null si no se ha puesto a cero. */
  relativeM: number | null;
  /** Velocidad vertical (m/s), positiva subiendo. */
  verticalSpeed: number;
  gainM: number;
  lossM: number;
}

/** Si pasan más de este tiempo sin datos, el filtro se reinicia (evita picos de velocidad). */
const MAX_GAP_S = 10;

export class BaroProcessor {
  readonly filter = new AlphaBetaFilter();
  readonly elevation = new ElevationAccumulator(2);
  private zeroAlt: number | null = null;
  private lastT: number | null = null;
  state: BaroState | null = null;

  /** @param tSec marca de tiempo de recepción en segundos. */
  update(p: EnvPacket, tSec: number): BaroState | null {
    if (!p.baroOk || !Number.isFinite(p.altitudeM) || !(p.pressurePa > 0)) return this.state;

    const dt = this.lastT === null ? 0 : tSec - this.lastT;
    if (dt > MAX_GAP_S) this.filter.reset();
    this.lastT = tSec;

    const f = this.filter.update(p.altitudeM, dt);
    this.elevation.update(f.x);

    this.state = {
      pressureHpa: p.pressurePa / 100,
      temperatureC: p.temperatureC,
      altitudeM: p.altitudeM,
      filteredAltM: f.x,
      relativeM: this.zeroAlt === null ? null : f.x - this.zeroAlt,
      verticalSpeed: f.v,
      gainM: this.elevation.gain,
      lossM: this.elevation.loss,
    };
    return this.state;
  }

  /** Pone a cero la altitud relativa en la altitud filtrada actual. */
  setZero(): boolean {
    if (!this.state) return false;
    this.zeroAlt = this.state.filteredAltM;
    this.state = { ...this.state, relativeM: 0 };
    return true;
  }

  clearZero(): void {
    this.zeroAlt = null;
    if (this.state) this.state = { ...this.state, relativeM: null };
  }

  /** Reinicia el desnivel acumulado de la sesión. */
  resetSession(): void {
    this.elevation.reset(this.state?.filteredAltM);
    if (this.state) this.state = { ...this.state, gainM: 0, lossM: 0 };
  }

  /** Olvida todo (p. ej. al cambiar de fuente de datos). */
  resetAll(): void {
    this.filter.reset();
    this.elevation.reset();
    this.zeroAlt = null;
    this.lastT = null;
    this.state = null;
  }
}

/** Atmósfera estándar ISA: altitud (m) → presión (Pa). Usado por el modo demo. */
export function pressureFromAltitude(h: number): number {
  return 101325 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
}

/** Atmósfera estándar ISA: presión (Pa) → altitud (m). */
export function altitudeFromPressure(p: number): number {
  return 44330.77 * (1 - Math.pow(p / 101325, 0.190263));
}
