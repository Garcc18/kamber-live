# KAMBER Live

Web app para móvil que se conecta por **Web Bluetooth** al dispositivo KAMBER (ESP32-S3 con IMU, barómetro y GPS en la bota de esquí) y muestra sus datos en tiempo real: modelo 3D, gráficas, mapa, barómetro, grabación de sesión (CSV / GPX) y modo demo.

- Vite + TypeScript (sin framework), three.js, Leaflet + OpenStreetMap, gráficas propias en `<canvas>`.
- PWA instalable (manifest + service worker); funciona sin internet salvo las teselas del mapa.
- Navegadores: **Chrome en Android** (o Chrome/Edge en ordenador). En **iPhone**, Safari no soporta Web Bluetooth: usa el navegador **Bluefy**.

## Arrancar en local

Requisitos: Node 20.19+ o 22.12+.

```bash
npm install
npm run dev        # http://localhost:5173  (en el ordenador, Web Bluetooth funciona en localhost)
npm test           # tests unitarios (Vitest)
npm run build      # genera dist/
```

Sin el dispositivo: pulsa **Demo**, o abre `http://localhost:5173/?demo`. Cada pestaña tiene su ancla: `#3d`, `#graficas`, `#mapa`, `#baro`, `#sesion`.

### Probar desde el móvil en local

Web Bluetooth solo funciona en un **contexto seguro** (HTTPS o `localhost`). Opciones:

1. **Reenvío de puertos por USB (recomendado).** Activa la depuración USB en el Android, conéctalo al PC, abre `chrome://inspect/#devices` en el Chrome del ordenador → *Port forwarding* → `5173` → `localhost:5173`. En el móvil abre `http://localhost:5173`: cuenta como `localhost`, así que Web Bluetooth funciona.
2. **HTTPS en la red local.** `npm run dev:lan` arranca Vite con `--host` y un certificado autofirmado. Abre en el móvil la dirección `https://192.168.x.x:5173` que muestra la consola y acepta el aviso del certificado (*Avanzado → Continuar*).
3. **GitHub Pages** (abajo): lo más cómodo para usarlo en la pista.

## Desplegar en GitHub Pages

El workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) ejecuta los tests, compila y publica `dist/` en cada push a `main`.

```bash
git init
git add .
git commit -m "KAMBER Live"
git branch -M main
git remote add origin https://github.com/<usuario>/<repo>.git
git push -u origin main
```

En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Tras el primer despliegue la app queda en `https://<usuario>.github.io/<repo>/` (la configuración usa rutas relativas, así que vale cualquier nombre de repositorio).

## Abrirla en el móvil

1. Enciende el KAMBER y activa el Bluetooth (y la ubicación, que Android pide para buscar dispositivos BLE).
2. Abre la URL de GitHub Pages en **Chrome** (Android) o **Bluefy** (iPhone).
3. Pulsa **Conectar** y elige `KAMBER` en la lista.
4. Opcional: menú ⋮ → **Añadir a pantalla de inicio / Instalar app**.

Si la conexión se pierde, la app reintenta sola hasta 8 veces (1, 2, 4… hasta 10 s entre intentos). Si no lo consigue, el botón pasa a **Reconectar**. Con datos llegando, la pantalla se mantiene encendida (se puede desactivar en Ajustes).

## Pantallas

| Pestaña | Qué muestra |
|---|---|
| **3D** | Caja del dispositivo con KAMBER en la tapa, flecha y cono naranja en la punta (+X), ejes X/Y/Z del sensor y rejilla de suelo. Interpolación slerp a partir del cuaternión (25 Hz). **Poner a cero** guarda la orientación actual como referencia. Canto (balanceo), cabeceo y rumbo. |
| **Gráficas** | Últimos 10 s: módulo de la aceleración (g), giroscopio X/Y/Z (°/s) y canto (°). |
| **Mapa** | Posición (flecha con el rumbo GPS), traza de la sesión, círculo de precisión aproximado, botón para seguir o dejar de seguir. Con `fix = 0`: «Buscando satélites… (n satélites)». Velocidad, velocidad máxima, altitud GPS, satélites y hora local. |
| **Baro** | Presión (hPa), temperatura, altitud barométrica, altitud relativa (con puesta a cero), velocidad vertical filtrada y desnivel acumulado de subida y bajada. |
| **Sesión** | Grabar / parar, contadores, exportar CSV y GPX, descartar y reiniciar estadísticas. |

Barra superior: conexión, estado, indicadores IMU · Baro · GPS (verde = bit de estado OK y llegan paquetes; ámbar = GPS sin posición; rojo = fallo o sin datos), paquetes por segundo de cada característica y batería (V y % estimado para LiPo).

### Convenciones de ángulos

Calculados en los ejes del sensor (X = punta, Y = izquierda, Z = arriba), relativos a la referencia si se ha puesto a cero:

- **Canto / balanceo**: positivo = inclinado a la derecha. Se muestra el valor absoluto con el lado.
- **Cabeceo**: positivo = punta arriba.
- **Rumbo**: positivo = giro a la derecha. Sin magnetómetro, **deriva** poco a poco.

### Ejes del modelo 3D

Por defecto `q_three = (x: qx, y: qz, z: −qy, w: qw)`. En **Ajustes** se elige qué eje del sensor (con signo) va a cada eje 3D. Las 48 combinaciones son válidas, también las que implican un reflejo: en ese caso se invierte la parte vectorial para que la rotación siga siendo propia. Los ángulos usan el mismo remapeo, así que también se corrigen si el sensor está montado girado. Al cambiar los ejes se quita el cero.

## Grabación y exportación

- **CSV**: una fila por paquete, con columnas `tiempo_s, fecha_hora_iso, tipo` (`imu`/`entorno`/`gps`) y luego los campos de cada tipo (las columnas de los otros tipos quedan vacías): `qw…qz, ax_g…az_g, gx_dps…gz_dps, presion_pa, temperatura_c, altitud_baro_m, bateria_mv, imu_ok, baro_ok, gps_datos, latitud, longitud, altitud_gps_m, velocidad_kmh, rumbo_deg, fix, satelites, hora_utc`. En Ajustes se puede elegir `;` con coma decimal para abrirlo directamente en Excel en español.
- **GPX 1.1**: un `trkpt` por paquete GPS con posición, con altitud, hora (UTC del GPS) y satélites.

La grabación vive en memoria (una hora son unos 90 000 paquetes, sin problema). Si intentas cerrar la página con una grabación sin exportar, el navegador lo avisa.

## Estructura

```
src/
  protocol.ts   UUIDs, decodificación con DataView (y codificadores para tests y demo)
  ble.ts        Conexión Web Bluetooth, suscripciones, reconexión, errores en español
  quat.ts       Cuaterniones, ángulos y remapeo de ejes
  baro.ts       Filtro alfa-beta (velocidad vertical), desnivel con histéresis, atmósfera ISA
  scene3d.ts    Modelo three.js con slerp (solo redibuja si cambia la orientación)
  map.ts        Leaflet: marcador, traza, precisión
  charts.ts     Gráficas en canvas con búferes circulares
  recorder.ts   Grabación y exportación CSV / GPX
  demo.ts       Simulación: bajada Borreguiles → Pradollano y subida en telecabina
  settings.ts   Ajustes en localStorage
  main.ts       Interfaz y bucle requestAnimationFrame
  *.test.ts     Tests (paquetes construidos a mano byte a byte)
public/
  manifest.webmanifest, sw.js, icons/
scripts/gen-icons.mjs   Regenera los iconos PNG (npm run icons)
```

Rendimiento: los datos se decodifican al llegar, pero la interfaz se pinta en un único bucle `requestAnimationFrame`. El texto se actualiza a unos 10 Hz, las gráficas a 30 fps como mucho y el 3D solo cuando su pestaña está visible y la orientación ha cambiado.

## Notas

- La precisión del mapa es una **estimación** a partir del número de satélites, porque el protocolo no envía HDOP.
- La ruta de la demo por la pista de Sierra Nevada es aproximada y sirve solo para probar la interfaz.
- Teselas © colaboradores de OpenStreetMap. Para un uso intensivo, usa un proveedor de teselas propio (cambia la URL en `src/map.ts`).
