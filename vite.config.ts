import { defineConfig } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';

// base: './' → rutas relativas, funciona en GitHub Pages sea cual sea el nombre del repositorio.
// `--mode https` activa un certificado autofirmado para probar desde el móvil en la red local.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
