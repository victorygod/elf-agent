import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-ui': path.resolve(__dirname, '../agents'),
      '@spa': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/agents': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
      '/rooms': 'http://localhost:8080',
      '/skills': 'http://localhost:8080',
      '/settings': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
      '/users': 'http://localhost:8080',
      '/subscribe': 'http://localhost:8080',
      '/available-tools': 'http://localhost:8080',
    },
  },
});