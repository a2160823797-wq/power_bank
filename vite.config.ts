import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      command === 'build' ? 'production' : 'development',
    ),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  build: {
    outDir: '.offline-build',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: fileURLToPath(new URL('./offline-entry.tsx', import.meta.url)),
      name: 'PowerBankOffline',
      formats: ['iife'],
      fileName: () => 'app.js',
      cssFileName: 'style',
    },
  },
}));
