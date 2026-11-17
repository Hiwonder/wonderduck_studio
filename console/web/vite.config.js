import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        debug: fileURLToPath(new URL('./debug.html', import.meta.url)),
      },
    },
  },
});
