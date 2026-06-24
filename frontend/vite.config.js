import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/agents': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
    },
  },
});