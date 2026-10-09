import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Three pages: the landing page (index.html), the simulator (simulator.html) and the video page (video.html).
const page = (file) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: page('./index.html'),
        simulator: page('./simulator.html'),
        video: page('./video.html'),
      },
    },
  },
});
