import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'outputs/mcp',
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./server.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'server.mjs',
    },
    rolldownOptions: {
      external: [/^node:/, /^@modelcontextprotocol\//, 'serialport', 'zod'],
    },
  },
});
