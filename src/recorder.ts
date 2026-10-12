// Grabación de la sesión y exportación a CSV y GPX.

import { utcHhmmssToDate, type EnvPacket, type GpsPacket, type ImuPacket } from './protocol';

export type RecordRow =
  | { t: number; kind: 'imu'; p: ImuPacket }
  | { t: number; kind: 'env'; p: EnvPacket }
  | { t: number; kind: 'gps'; p: GpsPacket };

export class Recorder {
  recording = false;
  rows: RecordRow[] = [];
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  counts = { imu: 0, env: 0, gps: 0 };

  start(now = Date.now()): void {
    this.clear();
    this.recording = true;
    this.startedAt = now;
  }

  stop(now = Date.now()): void {
    if (!this.recording) return;
    this.recording = false;
    this.stoppedAt = now;
  }

  clear(): void {
    this.recording = false;
    this.rows = [];
    this.startedAt = null;
    this.stoppedAt = null;
    this.counts = { imu: 0, env: 0, gps: 0 };
  }

  /** @param t marca de tiempo de recepción (ms desde epoch). */
  add(row: RecordRow): void {
    if (!this.recording) return;
    this.rows.push(row);
    this.counts[row.kind]++;
  }

  durationMs(now = Date.now()): number {
    if (this.startedAt === null) return 0;
    return (this.recording ? now : (this.stoppedAt ?? now)) - this.startedAt;
  }

  get hasData(): boolean {
    return this.rows.length > 0;
  }

  get gpsFixCount(): number {
    let n = 0;
    for (const r of this.rows) if (r.kind === 'gps' && r.p.fix > 0) n++;
    return n;
  }
}

// ---------- CSV ----------

export type CsvSeparator = ',' | ';';

export const CSV_COLUMNS = [
  'tiempo_s', 'fecha_hora_iso', 'tipo',
  'qw', 'qx', 'qy', 'qz',
  'ax_g', 'ay_g', 'az_g',
  'gx_dps', 'gy_dps', 'gz_dps',
  'presion_pa', 'temperatura_c', 'altitud_baro_m', 'bateria_mv', 'imu_ok', 'baro_ok', 'gps_datos',
  'latitud', 'longitud', 'altitud_gps_m', 'velocidad_kmh', 'rumbo_deg', 'fix', 'satelites', 'hora_utc',
] as const;

const KIND_LABEL = { imu: 'imu', env: 'entorno', gps: 'gps' } as const;

/**
 * Una fila por paquete; las columnas que no corresponden al tipo quedan vacías.
 * Con separador ';' se usa coma decimal (formato habitual de Excel en español).
 */
export function toCsv(rows: readonly RecordRow[], separator: CsvSeparator = ','): string {
  const decimalComma = separator === ';';
  const num = (v: number, digits: number) => {
    const s = Number.isFinite(v) ? v.toFixed(digits) : '';
    return decimalComma ? s.replace('.', ',') : s;
  };
  const int = (v: number) => String(Math.round(v));
  const bool = (b: boolean) => (b ? '1' : '0');
  const empty = (n: number) => new Array<string>(n).fill('');

  const lines: string[] = [CSV_COLUMNS.join(separator)];
  const t0 = rows.length ? rows[0].t : 0;

  for (const r of rows) {
    const head = [num((r.t - t0) / 1000, 3), new Date(r.t).toISOString(), KIND_LABEL[r.kind]];
    let imu = empty(10);
    let env = empty(7);
    let gps = empty(8);
    if (r.kind === 'imu') {
      const p = r.p;
      imu = [
        num(p.qw, 4), num(p.qx, 4), num(p.qy, 4), num(p.qz, 4),
        num(p.ax, 3), num(p.ay, 3), num(p.az, 3),
        num(p.gx, 1), num(p.gy, 1), num(p.gz, 1),
      ];
    } else if (r.kind === 'env') {
      const p = r.p;
      env = [
        num(p.pressurePa, 1), num(p.temperatureC, 2), num(p.altitudeM, 2), int(p.batteryMv),
        bool(p.imuOk), bool(p.baroOk), bool(p.gpsReceiving),
      ];
    } else {
      const p = r.p;
      gps = [
        num(p.lat, 7), num(p.lon, 7), int(p.altM), num(p.speedKmh, 2), num(p.courseDeg, 2),
        int(p.fix), int(p.satellites), String(p.utc).padStart(6, '0'),
      ];
    }
    lines.push([...head, ...imu, ...env, ...gps].join(separator));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------- GPX ----------

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Traza GPX 1.1 con los puntos GPS con posición (fix > 0). */
export function toGpx(rows: readonly RecordRow[], name = 'Sesión KAMBER'): string {
  const pts: string[] = [];
  let first: Date | null = null;
  for (const r of rows) {
    if (r.kind !== 'gps' || r.p.fix === 0) continue;
    const p = r.p;
    const received = new Date(r.t);
    const time = utcHhmmssToDate(p.utc, received) ?? received;
    first ??= time;
    pts.push(
      `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
        `<ele>${p.altM}</ele><time>${time.toISOString()}</time><sat>${p.satellites}</sat></trkpt>`,
    );
  }
  const meta = first ? `\n    <time>${first.toISOString()}</time>` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="KAMBER Live" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata>\n    <name>${xmlEscape(name)}</name>${meta}\n  </metadata>`,
    '  <trk>',
    `    <name>${xmlEscape(name)}</name>`,
    '    <trkseg>',
    ...pts,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

// ---------- Descarga ----------

export function sessionFileName(startedAt: number, ext: string): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `kamber_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
