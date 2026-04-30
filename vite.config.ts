import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/web'),
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@xterm/')) return 'xterm';
          if (id.includes('@codemirror/') || id.includes('@lezer/') || id.includes('@uiw/')) return 'codemirror';
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/web/shared'),
      '@ui': path.resolve(__dirname, 'src/web/ui'),
    },
  },
});
