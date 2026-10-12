// Ajustes persistentes (localStorage, con tolerancia a fallos: modo privado, almacenamiento bloqueado…).

import { DEFAULT_THREE_MAP, isValidMap, type AxisMap } from './quat';
import type { CsvSeparator } from './recorder';

export interface Settings {
  /** Conversión de ejes sensor → three.js. */
  axisMap: AxisMap;
  /** Mantener la pantalla encendida mientras llegan datos. */
  keepAwake: boolean;
  csvSeparator: CsvSeparator;
}

const KEY = 'kamber-live:settings';

export function defaultSettings(): Settings {
  return { axisMap: { ...DEFAULT_THREE_MAP }, keepAwake: true, csvSeparator: ',' };
}

export function loadSettings(): Settings {
  const s = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return s;
    const data = JSON.parse(raw) as Partial<Settings>;
    if (data.axisMap && isValidMap(data.axisMap)) s.axisMap = data.axisMap;
    if (typeof data.keepAwake === 'boolean') s.keepAwake = data.keepAwake;
    if (data.csvSeparator === ',' || data.csvSeparator === ';') s.csvSeparator = data.csvSeparator;
  } catch {
    // Sin almacenamiento: valores por defecto.
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Ignorar: los ajustes solo durarán esta sesión.
  }
}
