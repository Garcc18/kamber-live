// Mapa Leaflet con teselas de OpenStreetMap: posición actual, traza de la sesión y precisión aproximada.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GpsPacket } from './protocol';

/**
 * El protocolo no envía HDOP, así que la precisión se estima con el número de satélites
 * (≈ 3–4 m con buena cobertura, peor con pocos satélites; DGPS la mejora).
 */
export function approxAccuracyM(fix: number, sats: number): number {
  if (fix === 0) return 0;
  const base = 3.5 * Math.max(1, 8 / Math.max(1, sats));
  return fix >= 2 ? base * 0.6 : base;
}

/** Distancia en metros (fórmula de haversine). */
export function distanceM(a: L.LatLng, b: L.LatLng): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const ARROW_SVG =
  '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">' +
  '<circle cx="20" cy="20" r="11" fill="#ffb020" stroke="#0b0e12" stroke-width="3"/>' +
  '<path d="M20 2 L27 14 L13 14 Z" fill="#ffb020" stroke="#0b0e12" stroke-width="2" stroke-linejoin="round"/>' +
  '</svg>';

export class GpsMap {
  readonly map: L.Map;
  follow = true;
  private readonly marker: L.Marker;
  private readonly accuracy: L.Circle;
  private readonly track: L.Polyline;
  private lastPoint: L.LatLng | null = null;
  private hasPosition = false;
  private markerEl: HTMLElement | null = null;

  constructor(
    el: HTMLElement,
    private readonly onFollowChange: (follow: boolean) => void,
  ) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([37.087, -3.39], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);

    this.track = L.polyline([], { color: '#3987e5', weight: 4, opacity: 0.9 }).addTo(this.map);
    this.accuracy = L.circle([0, 0], { radius: 1, color: '#ffb020', weight: 1, fillOpacity: 0.12, interactive: false });
    this.marker = L.marker([0, 0], {
      icon: L.divIcon({ className: 'gps-marker', html: ARROW_SVG, iconSize: [40, 40], iconAnchor: [20, 20] }),
      keyboard: false,
      interactive: false,
    });

    // Si el usuario arrastra el mapa, dejamos de seguir.
    this.map.on('dragstart', () => this.setFollow(false));
  }

  setFollow(follow: boolean): void {
    if (this.follow === follow) return;
    this.follow = follow;
    this.onFollowChange(follow);
    if (follow && this.lastPoint) this.map.panTo(this.lastPoint, { animate: true });
  }

  /** Actualiza la posición. Con fix = 0 no se mueve nada. */
  update(p: GpsPacket): void {
    if (p.fix === 0 || (p.lat === 0 && p.lon === 0)) return;
    const ll = L.latLng(p.lat, p.lon);
    if (!this.hasPosition) {
      this.marker.addTo(this.map);
      this.accuracy.addTo(this.map);
      this.markerEl = this.marker.getElement() ?? null;
      this.hasPosition = true;
      this.marker.setLatLng(ll);
      this.map.setView(ll, Math.max(this.map.getZoom(), 16), { animate: false });
    }
    this.marker.setLatLng(ll);
    this.accuracy.setLatLng(ll);
    this.accuracy.setRadius(approxAccuracyM(p.fix, p.satellites));

    const svg = this.markerEl?.querySelector('svg');
    if (svg) svg.style.transform = `rotate(${p.courseDeg}deg)`;

    if (!this.lastPoint || distanceM(this.lastPoint, ll) >= 1) {
      this.track.addLatLng(ll);
      this.lastPoint = ll;
    }
    if (this.follow) this.map.panTo(ll, { animate: true, duration: 0.5 });
  }

  clearTrack(): void {
    this.track.setLatLngs([]);
    this.lastPoint = null;
  }

  /** Llamar al mostrar el mapa (estaba oculto y su tamaño era 0). */
  invalidate(): void {
    this.map.invalidateSize({ animate: false });
    if (this.follow && this.lastPoint) this.map.panTo(this.lastPoint, { animate: false });
  }
}
