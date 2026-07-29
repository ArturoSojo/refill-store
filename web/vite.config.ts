import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // En desarrollo la API vive en el emulador de Functions; el proxy evita
    // tener que lidiar con CORS y permite usar rutas relativas `/api/...`.
    //
    // El puerto 5051 (en vez del 5001 por defecto de Firebase) evita chocar con
    // otros servidores locales: un 5001 ocupado por otra app devuelve un
    // "Cannot GET /..." que parece un fallo de la tienda y no lo es.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5051/refill-e254f/us-central1/api',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
        // Sin backend levantado, devolver un JSON claro es mucho más útil que
        // el error críptico del proxy.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: {
                    code: 'maintenance',
                    message:
                      'La API local no está corriendo. Ejecuta `npm run dev:api` en otra terminal.',
                  },
                })
              );
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Separar las librerías pesadas hace que la primera carga en móvil
        // (el objetivo principal de la tienda) sea notablemente más rápida.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          charts: ['recharts'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
