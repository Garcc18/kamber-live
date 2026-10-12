// Cuaterniones y remapeo de ejes (sin dependencias de three.js para poder testearlo).
//
// Convención: q rota vectores del cuerpo (sensor) al mundo: v_mundo = q · v_cuerpo · q*.
// Ángulos de Euler ZYX intrínsecos (rumbo → cabeceo → balanceo) en un marco con Z hacia arriba.

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export type Vec3 = [number, number, number];

export const IDENTITY: Readonly<Quat> = Object.freeze({ w: 1, x: 0, y: 0, z: 0 });

export function normalize(q: Quat): Quat | null {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  if (!Number.isFinite(n) || n < 1e-6) return null;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

export function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function conjugate(q: Quat): Quat {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const r = multiply(multiply(q, { w: 0, x: v[0], y: v[1], z: v[2] }), conjugate(q));
  return [r.x, r.y, r.z];
}

/** Euler ZYX (radianes) → cuaternión. roll sobre X, pitch sobre Y, yaw sobre Z. */
export function fromEuler(roll: number, pitch: number, yaw: number): Quat {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  };
}

/** Cuaternión → Euler ZYX (radianes): rotación matemática sobre X, Y y Z. */
export function toEuler(q: Quat): { roll: number; pitch: number; yaw: number } {
  const { w, x, y, z } = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const s = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const pitch = Math.asin(s);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { roll, pitch, yaw };
}

export interface DisplayAngles {
  /** Balanceo en grados. Positivo = inclinado a la derecha (lado derecho abajo). Ángulo de canto. */
  roll: number;
  /** Cabeceo en grados. Positivo = punta hacia arriba. */
  pitch: number;
  /** Rumbo en grados (−180…180). Positivo = giro a la derecha (sentido horario visto desde arriba). */
  yaw: number;
}

const RAD2DEG = 180 / Math.PI;

/**
 * Ángulos para mostrar a partir del cuaternión del cuerpo (X = punta, Y = izquierda, Z = arriba).
 * La rotación positiva sobre Y baja la punta y la rotación positiva sobre Z gira a la izquierda,
 * así que se cambian de signo para que lo positivo sea "punta arriba" y "giro a la derecha".
 */
export function displayAngles(q: Quat): DisplayAngles {
  const e = toEuler(q);
  return { roll: e.roll * RAD2DEG, pitch: -e.pitch * RAD2DEG, yaw: -e.yaw * RAD2DEG };
}

// ---------- Remapeo de ejes ----------

export type AxisSource = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** Para cada eje de destino, de qué eje de origen (y con qué signo) sale. */
export interface AxisMap {
  x: AxisSource;
  y: AxisSource;
  z: AxisSource;
}

export const AXIS_SOURCES: readonly AxisSource[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** Sensor (Z arriba) → three.js (Y arriba): q_three = (x: qx, y: qz, z: −qy). */
export const DEFAULT_THREE_MAP: Readonly<AxisMap> = Object.freeze({ x: '+x', y: '+z', z: '-y' });
export const IDENTITY_MAP: Readonly<AxisMap> = Object.freeze({ x: '+x', y: '+y', z: '+z' });

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const TARGETS = ['x', 'y', 'z'] as const;

function parse(src: AxisSource): { sign: 1 | -1; index: 0 | 1 | 2 } {
  return { sign: src[0] === '-' ? -1 : 1, index: AXIS_INDEX[src[1] as 'x' | 'y' | 'z'] };
}

function make(sign: number, index: number): AxisSource {
  return `${sign < 0 ? '-' : '+'}${'xyz'[index]}` as AxisSource;
}

/** Válido si cada eje de origen se usa exactamente una vez. */
export function isValidMap(m: AxisMap): boolean {
  const used = new Set(TARGETS.map((t) => parse(m[t]).index));
  return used.size === 3;
}

/** Determinante de la matriz de permutación con signo: +1 rotación, −1 incluye un reflejo. */
export function mapDeterminant(m: AxisMap): 1 | -1 {
  const p = TARGETS.map((t) => parse(m[t]));
  let inversions = 0;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (p[i].index > p[j].index) inversions++;
  const sign = (inversions % 2 === 0 ? 1 : -1) * p[0].sign * p[1].sign * p[2].sign;
  return sign as 1 | -1;
}

export function applyMapToVector(m: AxisMap, v: Vec3): Vec3 {
  return TARGETS.map((t) => {
    const { sign, index } = parse(m[t]);
    return sign * v[index];
  }) as Vec3;
}

/**
 * Expresa una rotación en el nuevo marco: q' = M q M⁻¹.
 * La parte vectorial de un cuaternión es un pseudovector, así que con un reflejo (det = −1)
 * hay que invertirla para que la rotación resultante siga siendo propia.
 */
export function applyMapToQuat(m: AxisMap, q: Quat): Quat {
  const det = mapDeterminant(m);
  const [x, y, z] = applyMapToVector(m, [q.x, q.y, q.z]);
  return { w: q.w, x: det * x, y: det * y, z: det * z };
}

export function invertMap(m: AxisMap): AxisMap {
  const out: Partial<AxisMap> = {};
  TARGETS.forEach((t, i) => {
    const { sign, index } = parse(m[t]);
    out[TARGETS[index]] = make(sign, i);
  });
  return out as AxisMap;
}

/** Composición: (a ∘ b)(v) = a(b(v)). */
export function composeMaps(a: AxisMap, b: AxisMap): AxisMap {
  const out: Partial<AxisMap> = {};
  for (const t of TARGETS) {
    const pa = parse(a[t]);
    const pb = parse(b[TARGETS[pa.index]]);
    out[t] = make(pa.sign * pb.sign, pb.index);
  }
  return out as AxisMap;
}

/** Texto legible: "x: qx, y: qz, z: −qy". */
export function describeMap(m: AxisMap): string {
  return TARGETS.map((t) => {
    const { sign, index } = parse(m[t]);
    return `${t}: ${sign < 0 ? '−' : ''}q${'xyz'[index]}`;
  }).join(', ');
}
