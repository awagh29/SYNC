import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
// Absolute path of an HTML entry next to this config.
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 5173, strictPort: true },
  build: {
    chunkSizeWarningLimit: 1600,
    // Two pages: the existing console (index.html) and the mock-backed dashboard.
    rolldownOptions: {
      input: {
        main: page('./index.html'),
        dashboard: page('./dashboard.html'),
      },
    },
  },
});
