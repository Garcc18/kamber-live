// Modelo 3D del KAMBER con three.js. El cuaternión de destino llega a 25 Hz y se interpola
// con slerp en cada fotograma para que el movimiento sea suave.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Quat } from './quat';

// Dimensiones del dispositivo (mm → unidades de escena: 1 u = 10 mm).
// En el marco three.js: x = eje X del sensor (punta de la bota), y = arriba (Z sensor), z = −Y sensor.
const LEN_X = 5.8; // 58 mm a lo largo de la bota
const WIDTH = 5.2; // 52 mm
const HEIGHT = 3.0; // 30 mm

export const AXIS_COLORS = { x: '#e66767', y: '#199e70', z: '#3987e5' };

function labelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.strokeText(text, 32, 34);
  g.fillStyle = color;
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.9, 0.9, 1);
  s.renderOrder = 10;
  return s;
}

function lidTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = Math.round((512 * WIDTH) / LEN_X);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b313a';
  g.fillRect(0, 0, w, h);
  // Texto KAMBER
  g.fillStyle = '#f2f4f7';
  g.font = '800 92px system-ui, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('KAMBER', w / 2 - 20, h * 0.38);
  // Flecha hacia +X (derecha de la textura = punta de la bota)
  g.fillStyle = '#ffb020';
  const y = h * 0.72;
  g.fillRect(w * 0.18, y - 9, w * 0.5, 18);
  g.beginPath();
  g.moveTo(w * 0.86, y);
  g.lineTo(w * 0.66, y - 40);
  g.lineTo(w * 0.66, y + 40);
  g.closePath();
  g.fill();
  g.font = '700 34px system-ui, sans-serif';
  g.fillText('X', w * 0.92, y);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function axisArrow(dir: THREE.Vector3, color: string, label: string, length: number): THREE.Group {
  const g = new THREE.Group();
  const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), length, new THREE.Color(color).getHex(), 0.55, 0.32);
  (arrow.line.material as THREE.LineBasicMaterial).linewidth = 2;
  g.add(arrow);
  const s = labelSprite(label, color);
  s.position.copy(dir.clone().multiplyScalar(length + 0.45));
  g.add(s);
  return g;
}

export class DeviceScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private readonly device = new THREE.Group();
  private readonly target = new THREE.Quaternion();
  private width = 0;
  private height = 0;
  private dirty = true;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(8.5, 7, 11);
    this.camera.lookAt(0, -0.3, 0);

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2230, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(24, 24, 0x4a5566, 0x262e39);
    grid.position.y = -3.2;
    this.scene.add(grid);

    this.buildDevice();
    this.scene.add(this.device);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private buildDevice(): void {
    const body = new THREE.Mesh(
      new RoundedBoxGeometry(LEN_X, HEIGHT, WIDTH, 5, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x3a414c, roughness: 0.55, metalness: 0.1 }),
    );
    this.device.add(body);

    // Tapa con el texto y la flecha
    const lid = new THREE.Mesh(
      new THREE.PlaneGeometry(LEN_X - 0.9, WIDTH - 0.9),
      new THREE.MeshStandardMaterial({ map: lidTexture(), roughness: 0.7 }),
    );
    lid.rotation.x = -Math.PI / 2;
    lid.position.y = HEIGHT / 2 + 0.01;
    this.device.add(lid);

    // Franja inferior para distinguir arriba/abajo
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(LEN_X - 0.6, 0.25, WIDTH - 0.6),
      new THREE.MeshStandardMaterial({ color: 0x1b1f25, roughness: 0.9 }),
    );
    base.position.y = -HEIGHT / 2 - 0.05;
    this.device.add(base);

    // Punta: pequeño cono naranja en la cara +X
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 0.9, 24),
      new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.4 }),
    );
    tip.rotation.z = -Math.PI / 2;
    tip.position.x = LEN_X / 2 + 0.4;
    this.device.add(tip);

    // Ejes del sensor: X punta, Y izquierda (−z three), Z arriba (+y three)
    this.device.add(axisArrow(new THREE.Vector3(1, 0, 0), AXIS_COLORS.x, 'X', 4.6));
    this.device.add(axisArrow(new THREE.Vector3(0, 0, -1), AXIS_COLORS.y, 'Y', 4.2));
    this.device.add(axisArrow(new THREE.Vector3(0, 1, 0), AXIS_COLORS.z, 'Z', 3.4));
  }

  /** Cuaternión ya convertido al marco three.js. */
  setTarget(q: Quat): void {
    this.target.set(q.x, q.y, q.z, q.w).normalize();
    this.dirty = true;
  }

  /** Salta directamente a la orientación de destino (sin interpolar). */
  snap(): void {
    this.device.quaternion.copy(this.target);
    this.dirty = true;
  }

  resize(force = false): void {
    const r = this.container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.dirty = true;
    if (!force && r.width === this.width && r.height === this.height) return;
    this.width = r.width;
    this.height = r.height;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = r.width / r.height;
    // En vertical (estrecho) alejar la cámara para que quepa el modelo con los ejes
    const fit = Math.max(1, 1.25 / this.camera.aspect);
    this.camera.position.set(8.5, 7, 11).multiplyScalar(Math.min(fit, 1.6));
    this.camera.lookAt(0, -0.3, 0);
    this.camera.updateProjectionMatrix();
  }

  /** @param dt segundos desde el fotograma anterior. */
  render(dt: number): void {
    if (this.width === 0) this.resize();
    // Constante de tiempo ~50 ms: suave pero sin retraso apreciable a 25 Hz.
    // Si el modelo ya está en su sitio y nada ha cambiado, no se redibuja (ahorra batería).
    if (!this.dirty) return;
    const alpha = 1 - Math.exp(-Math.max(0, dt) / 0.05);
    this.device.quaternion.slerp(this.target, alpha);
    this.renderer.render(this.scene, this.camera);
    this.dirty = this.device.quaternion.angleTo(this.target) > 1e-4;
  }
}
