import { defineConfig } from 'vite';

// Dev: vite serves the client on 5173 and proxies websocket traffic to the
// game server on 3001. Prod: the game server serves dist/ itself, same origin.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
