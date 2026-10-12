// Gráficas en vivo ligeras sobre <canvas>: búferes circulares, escala automática suave
// y dibujo solo cuando se pide (el bucle principal las limita a ~30 fps y solo si son visibles).

export interface SeriesDef {
  label: string;
  color: string;
}

export interface LiveChartOptions {
  series: SeriesDef[];
  unit: string;
  /** Ventana visible en segundos. */
  windowSec?: number;
  /** Rango mínimo del eje Y; la escala solo crece por encima de esto. */
  minRange: [number, number];
  /** Decimales para los valores de la leyenda. */
  digits?: number;
}

const CAPACITY = 1024; // > 25 Hz × 10 s con margen

function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class LiveChart {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly times = new Float64Array(CAPACITY);
  private readonly values: Float32Array[];
  private head = 0;
  private count = 0;
  private yMin: number;
  private yMax: number;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private readonly windowMs: number;
  private colors = { grid: '#2a313b', text: '#9aa4b2', strong: '#e8ecf1', surface: '#151a21' };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: LiveChartOptions,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
    this.values = opts.series.map(() => new Float32Array(CAPACITY));
    this.windowMs = (opts.windowSec ?? 10) * 1000;
    [this.yMin, this.yMax] = opts.minRange;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  refreshTheme(): void {
    this.colors = {
      grid: cssVar('--chart-grid', this.colors.grid),
      text: cssVar('--text-muted', this.colors.text),
      strong: cssVar('--text', this.colors.strong),
      surface: cssVar('--surface', this.colors.surface),
    };
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.refreshTheme();
  }

  push(t: number, vals: readonly number[]): void {
    this.times[this.head] = t;
    for (let s = 0; s < this.values.length; s++) this.values[s][this.head] = vals[s];
    this.head = (this.head + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count++;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
    [this.yMin, this.yMax] = this.opts.minRange;
  }

  private idx(i: number): number {
    // i = 0 → muestra más antigua
    return (this.head - this.count + i + CAPACITY) % CAPACITY;
  }

  draw(now: number): void {
    if (this.width === 0) this.resize();
    if (this.width === 0) return;
    const { ctx, dpr, width: W, height: H } = this;
    const padL = 40, padR = 26, padT = 8, padB = 18;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const t0 = now - this.windowMs;

    // Primera muestra dentro de la ventana
    let first = 0;
    while (first < this.count && this.times[this.idx(first)] < t0 - 200) first++;

    // Escala automática: objetivo = datos ∪ rango mínimo; se acerca suavemente.
    let lo = this.opts.minRange[0];
    let hi = this.opts.minRange[1];
    for (let i = first; i < this.count; i++) {
      const k = this.idx(i);
      for (const v of this.values) {
        const x = v[k];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const ease = 0.15;
    this.yMin = lo < this.yMin ? lo : this.yMin + (lo - this.yMin) * ease;
    this.yMax = hi > this.yMax ? hi : this.yMax + (hi - this.yMax) * ease;
    const yMin = this.yMin;
    const yMax = this.yMax;
    const ySpan = yMax - yMin || 1;

    const X = (t: number) => padL + ((t - t0) / this.windowMs) * plotW;
    const Y = (v: number) => padT + (1 - (v - yMin) / ySpan) * plotH;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Rejilla y etiquetas del eje Y (recesivas)
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    const step = niceStep(ySpan, Math.max(2, Math.floor(plotH / 34)));
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = this.colors.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = this.colors.text;
      const label = Math.abs(step) < 1 ? v.toFixed(1) : v.toFixed(0);
      ctx.fillText(label === '-0' || label === '-0.0' ? label.slice(1) : label, padL - 6, y);
    }
    // Marcas de tiempo cada 2 s
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= this.windowMs / 1000; s += 2) {
      const x = padL + plotW - (s * 1000 * plotW) / this.windowMs;
      ctx.fillStyle = this.colors.text;
      ctx.fillText(s === 0 ? 'ahora' : `−${s} s`, Math.min(x, padL + plotW - 12), padT + plotH + 4);
    }

    // Series
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let s = 0; s < this.values.length; s++) {
      const v = this.values[s];
      ctx.strokeStyle = this.opts.series[s].color;
      ctx.beginPath();
      let started = false;
      for (let i = first; i < this.count; i++) {
        const k = this.idx(i);
        const x = X(this.times[k]);
        const y = Y(v[k]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Etiquetas directas al final de cada línea (identidad sin depender solo del color)
    if (this.count > 0 && this.values.length > 1) {
      const k = this.idx(this.count - 1);
      const lastX = Math.min(X(this.times[k]), padL + plotW);
      const ys = this.values.map((v, s) => ({ s, y: Y(v[k]) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ys.length; i++) if (ys[i].y - ys[i - 1].y < 13) ys[i].y = ys[i - 1].y + 13;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '600 11px system-ui, sans-serif';
      for (const { s, y } of ys) {
        ctx.fillStyle = this.opts.series[s].color;
        ctx.beginPath();
        ctx.arc(lastX + 5, Math.max(padT + 4, Math.min(padT + plotH - 4, y)), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = this.colors.strong;
        ctx.fillText(this.opts.series[s].label, lastX + 11, Math.max(padT + 4, Math.min(padT + plotH - 4, y)));
      }
    }
  }

  /** Último valor de cada serie (para la leyenda en HTML). */
  latest(): number[] | null {
    if (this.count === 0) return null;
    const k = this.idx(this.count - 1);
    return this.values.map((v) => v[k]);
  }
}
