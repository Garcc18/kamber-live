// Conexión Web Bluetooth con el KAMBER: búsqueda, suscripción a notificaciones y reconexión automática.

import {
  DEVICE_NAME,
  ENV_CHAR_UUID,
  GPS_CHAR_UUID,
  IMU_CHAR_UUID,
  SERVICE_UUID,
  type PacketKind,
} from './protocol';

export type BleStatus = 'idle' | 'requesting' | 'connecting' | 'connected' | 'reconnecting' | 'lost';

export interface BleCallbacks {
  onStatus(status: BleStatus, detail?: string): void;
  onData(kind: PacketKind, data: DataView): void;
  onError(message: string): void;
}

const CHARS: Record<PacketKind, string> = {
  imu: IMU_CHAR_UUID,
  env: ENV_CHAR_UUID,
  gps: GPS_CHAR_UUID,
};

const CONNECT_TIMEOUT_MS = 12_000;
export const MAX_RECONNECT_ATTEMPTS = 8;

export interface BleSupport {
  ok: boolean;
  reason?: string;
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function bleSupport(): BleSupport {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'Web Bluetooth necesita HTTPS (o localhost). Abre la app desde su dirección https://.',
    };
  }
  if (!('bluetooth' in navigator) || !navigator.bluetooth) {
    return {
      ok: false,
      reason: isIos()
        ? 'Safari de iPhone no soporta Web Bluetooth. Abre esta página con el navegador Bluefy (gratis en la App Store).'
        : 'Este navegador no soporta Web Bluetooth. Usa Chrome en Android (o Chrome/Edge en ordenador). En iPhone, usa el navegador Bluefy.',
    };
  }
  return { ok: true };
}

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Traduce los errores de Web Bluetooth a mensajes en español. */
export function bleErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? '';
  const msg = (e?.message ?? String(err)).toLowerCase();
  switch (name) {
    case 'NotFoundError':
      if (msg.includes('cancel')) return 'Búsqueda cancelada.';
      if (msg.includes('adapter') || msg.includes('bluetooth is') || msg.includes('not available')) {
        return 'Bluetooth desactivado o no disponible. Actívalo en el móvil y vuelve a intentarlo.';
      }
      if (msg.includes('service')) return 'El dispositivo no ofrece el servicio KAMBER. ¿Es el dispositivo correcto?';
      if (msg.includes('characteristic')) return 'Falta una característica del servicio KAMBER en el dispositivo.';
      return 'No se encontró ningún KAMBER. Comprueba que está encendido y cerca.';
    case 'SecurityError':
      return 'Permiso de Bluetooth denegado. La página debe abrirse por HTTPS y la conexión debe iniciarse con un toque.';
    case 'NetworkError':
      return 'No se pudo conectar: el KAMBER está fuera de alcance, apagado o conectado a otro móvil.';
    case 'NotSupportedError':
      return 'El navegador o el dispositivo no admite esta operación de Bluetooth.';
    case 'InvalidStateError':
      return 'Bluetooth en un estado no válido. Espera un momento y vuelve a intentarlo.';
    case 'NotAllowedError':
      return 'Permiso de Bluetooth denegado. Revisa los permisos del navegador (Bluetooth y dispositivos cercanos).';
    case 'TimeoutError':
      return 'Tiempo de espera agotado al conectar. Acércate al KAMBER y vuelve a intentarlo.';
    case 'AbortError':
      return 'Conexión interrumpida.';
    default:
      return `Error de Bluetooth: ${e?.message ?? String(err)}`;
  }
}

export class KamberBle {
  device: BluetoothDevice | null = null;
  status: BleStatus = 'idle';
  attempt = 0;

  private userDisconnect = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private setupRunning = false;
  private chars: BluetoothRemoteGATTCharacteristic[] = [];

  // Un manejador fijo por característica: addEventListener no duplica la misma función.
  private readonly handlers: Record<PacketKind, (ev: Event) => void> = {
    imu: (ev) => this.forward('imu', ev),
    env: (ev) => this.forward('env', ev),
    gps: (ev) => this.forward('gps', ev),
  };

  constructor(private readonly cb: BleCallbacks) {}

  get deviceName(): string {
    return this.device?.name ?? DEVICE_NAME;
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  private setStatus(s: BleStatus, detail?: string): void {
    this.status = s;
    this.cb.onStatus(s, detail);
  }

  private forward(kind: PacketKind, ev: Event): void {
    const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (value) this.cb.onData(kind, value);
  }

  /** Abre el selector del navegador y conecta. Debe llamarse desde un gesto del usuario. */
  async connect(): Promise<void> {
    const support = bleSupport();
    if (!support.ok) {
      this.cb.onError(support.reason!);
      return;
    }
    this.cancelRetry();
    this.userDisconnect = false;

    try {
      if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
        this.cb.onError('Bluetooth desactivado o no disponible. Actívalo en el móvil y vuelve a intentarlo.');
        return;
      }
    } catch {
      // Algunos navegadores (Bluefy) no implementan getAvailability: seguimos.
    }

    this.setStatus('requesting');
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }, { services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (err) {
      this.setStatus('idle');
      this.cb.onError(bleErrorMessage(err));
      return;
    }

    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.attempt = 0;

    try {
      await this.setup();
    } catch (err) {
      this.handleSetupError(err);
    }
  }

  /** Vuelve a conectar con el último dispositivo elegido (sin abrir el selector). */
  async reconnect(): Promise<void> {
    if (!this.device) return this.connect();
    this.cancelRetry();
    this.userDisconnect = false;
    this.attempt = 0;
    try {
      await this.setup();
    } catch (err) {
      this.handleSetupError(err);
    }
  }

  async disconnect(): Promise<void> {
    this.userDisconnect = true;
    this.cancelRetry();
    for (const c of this.chars) {
      try {
        await c.stopNotifications();
      } catch {
        // El enlace puede estar ya caído.
      }
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.setStatus('idle');
  }

  /** Olvida el dispositivo (p. ej. para elegir otro). */
  forget(): void {
    void this.disconnect();
    if (this.device) this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = null;
  }

  private async setup(): Promise<void> {
    const device = this.device;
    if (!device?.gatt) throw new Error('Dispositivo sin GATT');
    if (this.setupRunning) return;
    this.setupRunning = true;
    try {
      this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting', this.attempt > 0 ? String(this.attempt) : undefined);
      let server: BluetoothRemoteGATTServer;
      try {
        server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS);
      } catch (err) {
        // Cancela el intento pendiente para que no quede colgado.
        try {
          device.gatt.disconnect();
        } catch {
          /* nada */
        }
        throw err;
      }
      const service = await server.getPrimaryService(SERVICE_UUID);

      const chars: BluetoothRemoteGATTCharacteristic[] = [];
      const missing: string[] = [];
      for (const kind of Object.keys(CHARS) as PacketKind[]) {
        try {
          const c = await service.getCharacteristic(CHARS[kind]);
          c.addEventListener('characteristicvaluechanged', this.handlers[kind]);
          await c.startNotifications();
          chars.push(c);
        } catch (err) {
          console.warn(`No se pudo suscribir a ${kind}`, err);
          missing.push(kind === 'env' ? 'Entorno' : kind.toUpperCase());
        }
      }
      if (chars.length === 0) throw Object.assign(new Error('No characteristic'), { name: 'NotFoundError' });
      this.chars = chars;
      this.attempt = 0;
      this.setStatus('connected');
      if (missing.length) this.cb.onError(`Conectado, pero sin datos de: ${missing.join(', ')}.`);
    } finally {
      this.setupRunning = false;
    }
  }

  private handleSetupError(err: unknown): void {
    const name = (err as { name?: string })?.name;
    // Errores de enlace (fuera de alcance, tiempo agotado…) → reintentar. Otros → informar y parar.
    const transient = name === 'NetworkError' || name === 'TimeoutError' || name === 'AbortError' || name === 'InvalidStateError';
    if (transient && !this.userDisconnect) {
      this.scheduleReconnect(bleErrorMessage(err));
      return;
    }
    this.cb.onError(bleErrorMessage(err));
    if (this.device?.gatt?.connected) {
      this.userDisconnect = true;
      this.device.gatt.disconnect();
    }
    this.setStatus('idle');
  }

  private onDisconnected = (): void => {
    this.chars = [];
    if (this.userDisconnect) {
      this.setStatus('idle');
      return;
    }
    if (this.setupRunning) return; // el propio setup gestionará el fallo
    this.scheduleReconnect('Conexión perdida.');
  };

  private scheduleReconnect(reason: string): void {
    this.cancelRetry();
    this.attempt++;
    if (this.attempt > MAX_RECONNECT_ATTEMPTS) {
      this.attempt = 0;
      this.setStatus('lost', `${reason} No se pudo reconectar tras ${MAX_RECONNECT_ATTEMPTS} intentos.`);
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 10_000);
    this.setStatus('reconnecting', String(this.attempt));
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.userDisconnect) return;
      try {
        await this.setup();
      } catch (err) {
        this.handleSetupError(err);
      }
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
