import './style.css';
import { KamberBle, MAX_RECONNECT_ATTEMPTS, bleSupport, type BleStatus } from './ble';
import { DemoSource } from './demo';
import { BaroProcessor } from './baro';
import { LiveChart } from './charts';
import { DeviceScene, AXIS_COLORS } from './scene3d';
import { GpsMap } from './map';
import { Recorder, downloadText, sessionFileName, toCsv, toGpx } from './recorder';
import { loadSettings, saveSettings } from './settings';
import { decodeEnv, decodeGps, decodeImu, utcHhmmssToDate, type EnvPacket, type GpsPacket, type ImuPacket, type PacketKind } from './protocol';
import {
  AXIS_SOURCES,
  DEFAULT_THREE_MAP,
  applyMapToQuat,
  composeMaps,
  conjugate,
  describeMap,
  displayAngles,
  invertMap,
  isValidMap,
  mapDeterminant,
  multiply,
  normalize,
  type AxisMap,
  type AxisSource,
  type DisplayAngles,
  type Quat,
} from './quat';

// ---------- Utilidades DOM ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta el elemento #${id}`);
  return el as T;
};

const textCache = new WeakMap<HTMLElement, string>();
function setText(el: HTMLElement, text: string): void {
  if (textCache.get(el) === text) return;
  textCache.set(el, text);
  el.textContent = text;
}

function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string, kind: 'info' | 'ok' | 'error' = 'info', ms = 4000): void {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const fmt = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits).replace(/^-(0(\.0+)?)$/, '$1');

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

// ---------- Estado ----------

const settings = loadSettings();

type Source = 'none' | 'ble' | 'demo';
let source: Source = 'none';
let lastSourceKind: Source = 'none';
let bleStatus: BleStatus = 'idle';
let bleDetail = '';

const live = {
  imu: null as ImuPacket | null,
  env: null as EnvPacket | null,
  gps: null as GpsPacket | null,
  lastSeen: { imu: 0, env: 0, gps: 0 } as Record<PacketKind, number>,
  counts: { imu: 0, env: 0, gps: 0 } as Record<PacketKind, number>,
  prevCounts: { imu: 0, env: 0, gps: 0 } as Record<PacketKind, number>,
  rates: { imu: 0, env: 0, gps: 0 } as Record<PacketKind, number>,
  decodeErrors: 0,
  maxSpeed: 0,
};

// Orientación: sensor → cuerpo (para los ángulos) y cuerpo → three.js (para el modelo).
let sensorToBody: AxisMap = sensorToBodyMap(settings.axisMap);
function sensorToBodyMap(m: AxisMap): AxisMap {
  // Con el mapa por defecto el resultado es la identidad: los ángulos se calculan en los ejes del sensor.
  return composeMaps(invertMap(DEFAULT_THREE_MAP), m);
}
let tareRef: Quat | null = null;
let lastBodyQ: Quat | null = null;
let angles: DisplayAngles | null = null;

const baro = new BaroProcessor();
const recorder = new Recorder();
let exportedSinceStop = true;

// ---------- Vistas ----------

let activeView = 'view-3d';

let scene: DeviceScene | null = null;
try {
  scene = new DeviceScene($('scene'));
} catch (err) {
  console.error(err);
  $('scene-fallback').hidden = false;
}

const charts = {
  acc: new LiveChart($<HTMLCanvasElement>('chart-acc'), {
    series: [{ label: '|a|', color: '#c98500' }],
    unit: 'g',
    minRange: [0, 2],
  }),
  gyro: new LiveChart($<HTMLCanvasElement>('chart-gyro'), {
    series: [
      { label: 'X', color: AXIS_COLORS.x },
      { label: 'Y', color: AXIS_COLORS.y },
      { label: 'Z', color: AXIS_COLORS.z },
    ],
    unit: '°/s',
    minRange: [-50, 50],
  }),
  roll: new LiveChart($<HTMLCanvasElement>('chart-roll'), {
    series: [{ label: 'canto', color: '#9085e9' }],
    unit: '°',
    minRange: [-20, 20],
  }),
};
const chartList = Object.values(charts);

const gpsMap = new GpsMap($('map'), (follow) => {
  const b = $('btn-follow');
  b.setAttribute('aria-pressed', String(follow));
  b.textContent = follow ? 'Siguiendo' : 'Seguir';
});

function showView(id: string): void {
  activeView = id;
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === id));
  if (id === 'view-map') requestAnimationFrame(() => gpsMap.invalidate());
  if (id === 'view-charts') requestAnimationFrame(() => chartList.forEach((c) => c.resize()));
  if (id === 'view-3d') requestAnimationFrame(() => scene?.resize(true));
}

// Cada pestaña tiene un ancla (#3d, #graficas, #mapa, #baro, #sesion) para enlazarla directamente.
const VIEW_HASH: Record<string, string> = {
  'view-3d': '3d', 'view-charts': 'graficas', 'view-map': 'mapa', 'view-baro': 'baro', 'view-session': 'sesion',
};
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    showView(t.dataset.view!);
    history.replaceState(null, '', `#${VIEW_HASH[t.dataset.view!]}`);
  }),
);

// ---------- Ingesta de datos (BLE y demo comparten este camino) ----------

function ingest(kind: PacketKind, dv: DataView): void {
  const now = performance.now();
  const wall = Date.now();
  try {
    if (kind === 'imu') {
      const p = decodeImu(dv);
      handleImu(p, now);
      recorder.add({ t: wall, kind, p });
    } else if (kind === 'env') {
      const p = decodeEnv(dv);
      live.env = p;
      baro.update(p, now / 1000);
      recorder.add({ t: wall, kind, p });
    } else {
      const p = decodeGps(dv);
      handleGps(p);
      recorder.add({ t: wall, kind, p });
    }
  } catch (err) {
    live.decodeErrors++;
    if (live.decodeErrors <= 5) console.warn('Paquete no válido', kind, err);
    return;
  }
  live.lastSeen[kind] = now;
  live.counts[kind]++;
}

function handleImu(p: ImuPacket, now: number): void {
  live.imu = p;
  const raw = normalize({ w: p.qw, x: p.qx, y: p.qy, z: p.qz });
  if (raw) {
    const body = applyMapToQuat(sensorToBody, raw);
    lastBodyQ = body;
    const rel = tareRef ? multiply(conjugate(tareRef), body) : body;
    angles = displayAngles(rel);
    scene?.setTarget(applyMapToQuat(DEFAULT_THREE_MAP, rel));
  }
  charts.acc.push(now, [Math.hypot(p.ax, p.ay, p.az)]);
  charts.gyro.push(now, [p.gx, p.gy, p.gz]);
  if (angles) charts.roll.push(now, [angles.roll]);
}

function handleGps(p: GpsPacket): void {
  live.gps = p;
  if (p.fix > 0 && p.satellites >= 4 && p.speedKmh < 250) live.maxSpeed = Math.max(live.maxSpeed, p.speedKmh);
  gpsMap.update(p);
}

function resetLiveData(): void {
  live.imu = live.env = live.gps = null;
  live.lastSeen = { imu: 0, env: 0, gps: 0 };
  live.maxSpeed = 0;
  angles = null;
  lastBodyQ = null;
  tareRef = null;
  baro.resetAll();
  chartList.forEach((c) => c.clear());
  gpsMap.clearTrack();
}

/** Al pasar de demo a dispositivo real (o al revés) se empieza de cero. */
function beginSource(kind: Source): void {
  if (kind !== lastSourceKind) resetLiveData();
  lastSourceKind = kind;
  source = kind;
}

// ---------- Bluetooth ----------

const support = bleSupport();
if (!support.ok) {
  const banner = $('banner');
  banner.textContent = `${support.reason} Puedes probar la interfaz con el botón Demo.`;
  banner.hidden = false;
}

const ble = new KamberBle({
  onData: (kind, dv) => {
    if (source === 'ble') ingest(kind, dv);
  },
  onError: (msg) => toast(msg, msg === 'Búsqueda cancelada.' ? 'info' : 'error', 5000),
  onStatus: (s, detail) => {
    const prev = bleStatus;
    bleStatus = s;
    bleDetail = detail ?? '';
    if (s === 'connected') {
      if (demo.running) stopDemo();
      beginSource('ble');
      toast(prev === 'reconnecting' ? 'Reconectado.' : `Conectado a ${ble.deviceName}.`, 'ok', 2500);
    } else if (s === 'reconnecting') {
      if (prev === 'connected') toast('Conexión perdida. Reintentando…', 'error', 3500);
    } else if (s === 'lost') {
      toast(`${bleDetail} Pulsa «Reconectar».`, 'error', 8000);
    } else if (s === 'idle' && source === 'ble') {
      source = 'none';
    }
    $('btn-forget').hidden = !ble.device;
    updateControls();
    void updateWakeLock();
  },
});

$('btn-connect').addEventListener('click', () => {
  switch (bleStatus) {
    case 'idle':
      if (demo.running) stopDemo();
      void ble.connect();
      break;
    case 'connected':
    case 'connecting':
    case 'reconnecting':
      void ble.disconnect();
      break;
    case 'lost':
      void ble.reconnect();
      break;
    case 'requesting':
      break;
  }
});

$('btn-forget').addEventListener('click', () => {
  ble.forget();
  $('btn-forget').hidden = true;
  toast('Dispositivo olvidado. La próxima conexión abrirá el selector.');
});

// ---------- Demo ----------

const demo = new DemoSource((kind, dv) => {
  if (source === 'demo') ingest(kind, dv);
});

function stopDemo(): void {
  demo.stop();
  if (source === 'demo') source = 'none';
  updateControls();
  void updateWakeLock();
}

$('btn-demo').addEventListener('click', () => {
  if (demo.running) {
    stopDemo();
    toast('Demo detenida.');
    return;
  }
  if (bleStatus !== 'idle' && bleStatus !== 'lost') return;
  beginSource('demo');
  demo.start();
  toast('Modo demo: bajando por Sierra Nevada.', 'ok', 2500);
  updateControls();
  void updateWakeLock();
});

function updateControls(): void {
  const connect = $<HTMLButtonElement>('btn-connect');
  const labels: Record<BleStatus, string> = {
    idle: 'Conectar',
    requesting: 'Buscando…',
    connecting: 'Cancelar',
    connected: 'Desconectar',
    reconnecting: 'Cancelar',
    lost: 'Reconectar',
  };
  setText(connect, labels[bleStatus]);
  connect.disabled = !support.ok || bleStatus === 'requesting';
  connect.classList.toggle('primary', bleStatus === 'idle' || bleStatus === 'lost');

  const demoBtn = $<HTMLButtonElement>('btn-demo');
  setText(demoBtn, demo.running ? 'Parar demo' : 'Demo');
  demoBtn.disabled = !demo.running && bleStatus !== 'idle' && bleStatus !== 'lost';
  demoBtn.classList.toggle('active', demo.running);

  const statusEl = $('status');
  let state: string = bleStatus;
  let text: string;
  if (demo.running) {
    state = 'demo';
    text = 'Modo demo';
  } else {
    text = {
      idle: 'Desconectado',
      requesting: 'Buscando…',
      connecting: 'Conectando…',
      connected: `Conectado · ${ble.deviceName}`,
      reconnecting: `Perdido · reintento ${bleDetail}/${MAX_RECONNECT_ATTEMPTS}`,
      lost: 'Conexión perdida',
    }[bleStatus];
  }
  setAttr(statusEl, 'data-state', state);
  setText($('status-text'), text);
}

// ---------- Orientación: tara ----------

$('btn-tare').addEventListener('click', () => {
  if (!lastBodyQ) {
    toast('Aún no llegan datos de orientación.', 'error');
    return;
  }
  tareRef = lastBodyQ;
  toast('Orientación actual guardada como referencia.', 'ok', 2000);
  updateTareUi();
});
$('btn-untare').addEventListener('click', () => {
  tareRef = null;
  updateTareUi();
});
function updateTareUi(): void {
  $<HTMLButtonElement>('btn-untare').disabled = !tareRef;
  $('tare-badge').hidden = !tareRef;
}

// ---------- Mapa ----------

$('btn-follow').addEventListener('click', () => gpsMap.setFollow(!gpsMap.follow));
$('btn-clear-track').addEventListener('click', () => {
  gpsMap.clearTrack();
  toast('Traza borrada.');
});
$('btn-reset-max').addEventListener('click', () => {
  live.maxSpeed = 0;
});

// ---------- Barómetro ----------

$('btn-baro-zero').addEventListener('click', () => {
  if (baro.setZero()) toast('Altitud relativa puesta a cero.', 'ok', 2000);
  else toast('Aún no llegan datos del barómetro.', 'error');
});
$('btn-baro-reset').addEventListener('click', () => {
  baro.resetSession();
  toast('Desnivel acumulado reiniciado.');
});

// ---------- Grabación ----------

function toggleRecording(): void {
  if (recorder.recording) {
    recorder.stop();
    exportedSinceStop = false;
    toast(`Grabación parada: ${recorder.rows.length.toLocaleString('es-ES')} paquetes.`, 'ok');
  } else {
    if (recorder.hasData && !exportedSinceStop && !confirm('La grabación anterior no se ha exportado. ¿Empezar una nueva y descartarla?')) return;
    recorder.start();
    exportedSinceStop = false;
    if (source === 'none') toast('Grabando, pero aún no llegan datos. Conecta el KAMBER o activa la demo.');
  }
  updateRecordingUi(performance.now(), true);
}
$('btn-record').addEventListener('click', toggleRecording);
$('btn-record-2').addEventListener('click', toggleRecording);

$('btn-export-csv').addEventListener('click', () => {
  if (!recorder.hasData || recorder.startedAt === null) return;
  downloadText(sessionFileName(recorder.startedAt, 'csv'), toCsv(recorder.rows, settings.csvSeparator), 'text/csv;charset=utf-8');
  exportedSinceStop = true;
});
$('btn-export-gpx').addEventListener('click', () => {
  if (!recorder.hasData || recorder.startedAt === null) return;
  if (recorder.gpsFixCount === 0) {
    toast('La grabación no tiene puntos GPS con posición.', 'error');
    return;
  }
  const name = `KAMBER ${new Date(recorder.startedAt).toLocaleString('es-ES')}`;
  downloadText(sessionFileName(recorder.startedAt, 'gpx'), toGpx(recorder.rows, name), 'application/gpx+xml');
  exportedSinceStop = true;
});
$('btn-discard').addEventListener('click', () => {
  if (!recorder.hasData || confirm('¿Descartar la grabación? No se puede deshacer.')) {
    recorder.clear();
    exportedSinceStop = true;
    updateRecordingUi(performance.now(), true);
  }
});

$('btn-reset-session').addEventListener('click', () => {
  live.maxSpeed = 0;
  baro.resetSession();
  gpsMap.clearTrack();
  toast('Estadísticas de la sesión reiniciadas.');
});

window.addEventListener('beforeunload', (e) => {
  if (recorder.recording || (recorder.hasData && !exportedSinceStop)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

let lastRecUi = 0;
function updateRecordingUi(now: number, force = false): void {
  if (!force && now - lastRecUi < 250) return;
  lastRecUi = now;
  const rec = recorder.recording;
  const dur = fmtDuration(recorder.durationMs());
  for (const id of ['btn-record', 'btn-record-2']) $(id).classList.toggle('active', rec);
  setText($('btn-record-text'), rec ? 'Parar' : 'Grabar');
  setText($('btn-record-2-text'), rec ? 'Parar grabación' : 'Grabar');
  $('rec-badge').hidden = !rec;
  setText($('rec-badge-time'), dur);
  setText($('rec-state'), rec ? 'Grabando' : recorder.hasData ? 'Parada' : 'Sin datos');
  setText($('rec-duration'), dur);
  setText($('rec-imu'), recorder.counts.imu.toLocaleString('es-ES'));
  setText($('rec-env'), recorder.counts.env.toLocaleString('es-ES'));
  setText($('rec-gps'), recorder.counts.gps.toLocaleString('es-ES'));
  if (force || !rec) setText($('rec-fix'), recorder.gpsFixCount.toLocaleString('es-ES'));
  const has = recorder.hasData;
  $<HTMLButtonElement>('btn-export-csv').disabled = !has;
  $<HTMLButtonElement>('btn-export-gpx').disabled = !has;
  $<HTMLButtonElement>('btn-discard').disabled = !has && !rec;
}

// ---------- Ajustes ----------

const dialog = $<HTMLDialogElement>('settings-dialog');
const axisSelects = {
  x: $<HTMLSelectElement>('map-x'),
  y: $<HTMLSelectElement>('map-y'),
  z: $<HTMLSelectElement>('map-z'),
};
const SOURCE_LABEL: Record<AxisSource, string> = {
  '+x': '+X sensor', '-x': '−X sensor', '+y': '+Y sensor', '-y': '−Y sensor', '+z': '+Z sensor', '-z': '−Z sensor',
};
for (const sel of Object.values(axisSelects)) {
  for (const src of AXIS_SOURCES) sel.add(new Option(SOURCE_LABEL[src], src));
}

function fillSettingsForm(): void {
  axisSelects.x.value = settings.axisMap.x;
  axisSelects.y.value = settings.axisMap.y;
  axisSelects.z.value = settings.axisMap.z;
  $<HTMLInputElement>('opt-awake').checked = settings.keepAwake;
  $<HTMLSelectElement>('opt-csv').value = settings.csvSeparator;
  showFormula(settings.axisMap);
}

function showFormula(m: AxisMap): void {
  const valid = isValidMap(m);
  $('map-error').hidden = valid;
  $('map-formula').textContent = valid
    ? `q_three = (${describeMap(m)}, w: qw)${mapDeterminant(m) < 0 ? ' · con reflejo (espejo)' : ''}`
    : '—';
}

function applyAxisMap(m: AxisMap): void {
  showFormula(m);
  if (!isValidMap(m)) return;
  settings.axisMap = { ...m };
  sensorToBody = sensorToBodyMap(settings.axisMap);
  saveSettings(settings);
  if (tareRef) {
    tareRef = null;
    updateTareUi();
    toast('Ejes cambiados: se ha quitado el cero.');
  }
}

for (const sel of Object.values(axisSelects)) {
  sel.addEventListener('change', () =>
    applyAxisMap({ x: axisSelects.x.value as AxisSource, y: axisSelects.y.value as AxisSource, z: axisSelects.z.value as AxisSource }),
  );
}
$('btn-map-reset').addEventListener('click', () => {
  applyAxisMap({ ...DEFAULT_THREE_MAP });
  fillSettingsForm();
});
$<HTMLInputElement>('opt-awake').addEventListener('change', (e) => {
  settings.keepAwake = (e.target as HTMLInputElement).checked;
  saveSettings(settings);
  void updateWakeLock();
});
$<HTMLSelectElement>('opt-csv').addEventListener('change', (e) => {
  settings.csvSeparator = (e.target as HTMLSelectElement).value === ';' ? ';' : ',';
  saveSettings(settings);
});
$('btn-settings').addEventListener('click', () => {
  fillSettingsForm();
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  // Si se cerró con un mapa inválido, volver al último válido
  fillSettingsForm();
});

// ---------- Pantalla encendida ----------

let wakeLock: WakeLockSentinel | null = null;
let wakePending = false;
async function updateWakeLock(): Promise<void> {
  const active = source === 'demo' || bleStatus === 'connected' || bleStatus === 'reconnecting';
  const want = settings.keepAwake && active && document.visibilityState === 'visible';
  if (want && !wakeLock && !wakePending && 'wakeLock' in navigator) {
    wakePending = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {
      // No disponible (batería baja, permisos…): seguimos sin él.
    } finally {
      wakePending = false;
    }
  } else if (!want && wakeLock) {
    const wl = wakeLock;
    wakeLock = null;
    await wl.release().catch(() => undefined);
  }
}
document.addEventListener('visibilitychange', () => void updateWakeLock());

// ---------- Actualización de la interfaz (requestAnimationFrame) ----------

const LIPO_CURVE: [number, number][] = [
  [3300, 0], [3500, 5], [3600, 12], [3700, 28], [3800, 45], [3900, 62], [4000, 78], [4100, 90], [4200, 100],
];
function batteryPercent(mv: number): number {
  if (mv <= LIPO_CURVE[0][0]) return 0;
  for (let i = 1; i < LIPO_CURVE.length; i++) {
    const [v1, p1] = LIPO_CURVE[i];
    if (mv <= v1) {
      const [v0, p0] = LIPO_CURVE[i - 1];
      return p0 + ((mv - v0) / (v1 - v0)) * (p1 - p0);
    }
  }
  return 100;
}

type IndState = 'off' | 'ok' | 'warn' | 'bad';
function indicatorStates(now: number): Record<'imu' | 'baro' | 'gps', IndState> {
  const active = source === 'demo' || (source === 'ble' && bleStatus !== 'idle');
  if (!active) return { imu: 'off', baro: 'off', gps: 'off' };
  const fresh = (k: PacketKind, maxAge: number) => live.lastSeen[k] > 0 && now - live.lastSeen[k] < maxAge;
  const envFresh = fresh('env', 3500);
  const env = envFresh ? live.env : null;
  const imu: IndState = fresh('imu', 1000) && (env ? env.imuOk : true) ? 'ok' : 'bad';
  const baroS: IndState = env && env.baroOk ? 'ok' : 'bad';
  let gps: IndState = 'bad';
  if (fresh('gps', 3500) && (env ? env.gpsReceiving : true)) gps = live.gps && live.gps.fix > 0 ? 'ok' : 'warn';
  return { imu, baro: baroS, gps };
}

const el = {
  indImu: $('ind-imu'), indBaro: $('ind-baro'), indGps: $('ind-gps'),
  rateImu: $('rate-imu'), rateEnv: $('rate-env'), rateGps: $('rate-gps'),
  battery: $('battery'), batteryText: $('battery-text'), batteryFill: $('battery-fill'),
  roll: $('ang-roll'), rollSide: $('ang-roll-side'), pitch: $('ang-pitch'), yaw: $('ang-yaw'),
  valAcc: $('val-acc'), valGx: $('val-gx'), valGy: $('val-gy'), valGz: $('val-gz'), valRoll: $('val-roll'),
  gpsWait: $('gps-wait'), gpsSpeed: $('gps-speed'), gpsMax: $('gps-max'), gpsAlt: $('gps-alt'),
  gpsSats: $('gps-sats'), gpsFix: $('gps-fix'), gpsTime: $('gps-time'), gpsCourse: $('gps-course'),
  baroVs: $('baro-vs'), baroVsArrow: $('baro-vs-arrow'), baroRel: $('baro-rel'), baroAlt: $('baro-alt'),
  baroGain: $('baro-gain'), baroLoss: $('baro-loss'), baroP: $('baro-p'), baroT: $('baro-t'),
};

const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function updateUi(now: number): void {
  // Indicadores y tasas
  const ind = indicatorStates(now);
  setAttr(el.indImu, 'data-state', ind.imu);
  setAttr(el.indBaro, 'data-state', ind.baro);
  setAttr(el.indGps, 'data-state', ind.gps);
  setText(el.rateImu, `${fmt(live.rates.imu)}/s`);
  setText(el.rateEnv, `${fmt(live.rates.env)}/s`);
  setText(el.rateGps, `${fmt(live.rates.gps)}/s`);

  // Batería
  const mv = source !== 'none' ? live.env?.batteryMv ?? 0 : 0;
  if (mv > 0) {
    const pct = batteryPercent(mv);
    setText(el.batteryText, `${(mv / 1000).toFixed(2)} V · ${Math.round(pct)}%`);
    setAttr(el.battery, 'data-level', pct < 15 ? 'low' : pct < 35 ? 'mid' : 'ok');
    setAttr(el.batteryFill, 'width', (15 * pct / 100).toFixed(1));
  } else {
    setText(el.batteryText, '—');
    setAttr(el.batteryFill, 'width', '0');
  }

  // Ángulos
  if (angles) {
    const r = angles.roll;
    setText(el.roll, fmt(Math.abs(r), 1));
    setText(el.rollSide, Math.abs(r) < 1 ? 'plano' : r > 0 ? 'derecha →' : '← izquierda');
    setText(el.pitch, fmt(angles.pitch));
    setText(el.yaw, fmt(angles.yaw));
  } else {
    setText(el.roll, '—');
    setText(el.pitch, '—');
    setText(el.yaw, '—');
  }

  // Leyendas de las gráficas
  if (activeView === 'view-charts') {
    const a = charts.acc.latest();
    const g = charts.gyro.latest();
    const r = charts.roll.latest();
    setText(el.valAcc, a ? fmt(a[0], 2) : '—');
    setText(el.valGx, g ? fmt(g[0]) : '—');
    setText(el.valGy, g ? fmt(g[1]) : '—');
    setText(el.valGz, g ? fmt(g[2]) : '—');
    setText(el.valRoll, r ? fmt(r[0], 1) : '—');
  }

  // GPS
  const gps = live.gps;
  const gpsFresh = live.lastSeen.gps > 0 && now - live.lastSeen.gps < 3500;
  if (source === 'none' && !gps) {
    el.gpsWait.hidden = false;
    setText(el.gpsWait, 'Conecta el KAMBER o activa la demo');
  } else if (!gpsFresh) {
    el.gpsWait.hidden = false;
    setText(el.gpsWait, 'Sin datos GPS');
  } else if (gps && gps.fix === 0) {
    el.gpsWait.hidden = false;
    setText(el.gpsWait, `Buscando satélites… (${gps.satellites} satélites)`);
  } else {
    el.gpsWait.hidden = true;
  }
  const hasFix = !!gps && gps.fix > 0 && gpsFresh;
  setText(el.gpsSpeed, hasFix ? fmt(gps!.speedKmh, 1) : '—');
  setText(el.gpsMax, live.maxSpeed > 0 ? fmt(live.maxSpeed, 1) : '—');
  setText(el.gpsAlt, hasFix ? fmt(gps!.altM) : '—');
  setText(el.gpsCourse, hasFix ? fmt(gps!.courseDeg) : '—');
  setText(el.gpsSats, gps ? String(gps.satellites) : '—');
  setText(el.gpsFix, gps ? (gps.fix === 2 ? 'DGPS' : gps.fix === 1 ? 'GPS' : 'sin fix') : '');
  const utc = gps && gps.utc > 0 ? utcHhmmssToDate(gps.utc) : null;
  setText(el.gpsTime, utc ? timeFmt.format(utc) : '—');

  // Barómetro
  const b = baro.state;
  if (b) {
    const vs = b.verticalSpeed;
    setText(el.baroVs, fmt(vs, 1));
    setText(el.baroVsArrow, Math.abs(vs) < 0.1 ? '' : vs > 0 ? '▲' : '▼');
    el.baroVsArrow.className = `vs-arrow ${vs >= 0.1 ? 'vs-up' : vs <= -0.1 ? 'vs-down' : ''}`;
    setText(el.baroRel, b.relativeM === null ? '—' : `${b.relativeM >= 0.05 ? '+' : ''}${fmt(b.relativeM, 1)}`);
    setText(el.baroAlt, fmt(b.altitudeM));
    setText(el.baroGain, fmt(b.gainM));
    setText(el.baroLoss, fmt(b.lossM));
    setText(el.baroP, fmt(b.pressureHpa, 1));
    setText(el.baroT, fmt(b.temperatureC, 1));
  } else {
    for (const e of [el.baroVs, el.baroRel, el.baroAlt, el.baroGain, el.baroLoss, el.baroP, el.baroT]) setText(e, '—');
    setText(el.baroVsArrow, '');
  }
}

let lastFrame = performance.now();
let lastUi = 0;
let lastChart = 0;
let lastRate = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  if (now - lastRate >= 1000) {
    const secs = (now - lastRate) / 1000;
    for (const k of ['imu', 'env', 'gps'] as PacketKind[]) {
      live.rates[k] = (live.counts[k] - live.prevCounts[k]) / secs;
      live.prevCounts[k] = live.counts[k];
    }
    lastRate = now;
  }
  if (now - lastUi >= 100) {
    updateUi(now);
    updateRecordingUi(now);
    lastUi = now;
  }
  if (activeView === 'view-3d' && scene) scene.render(dt);
  if (activeView === 'view-charts' && now - lastChart >= 33) {
    for (const c of chartList) c.draw(now);
    lastChart = now;
  }
  requestAnimationFrame(frame);
}

// ---------- Arranque ----------

const initialView = Object.keys(VIEW_HASH).find((k) => `#${VIEW_HASH[k]}` === location.hash);
if (initialView) showView(initialView);
// ?demo arranca directamente el modo demo (útil para enseñar la app sin el dispositivo).
if (new URLSearchParams(location.search).has('demo')) $('btn-demo').click();

updateControls();
updateTareUi();
updateRecordingUi(performance.now(), true);
fillSettingsForm();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker no registrado', err));
  });
}
