import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },

  // Build output → dashboard/dist (Server จะ serve จากที่นี่)
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chunk splitting สำหรับ performance
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          socket: ['socket.io-client'],
        },
      },
    },
  },

  // Dev server: proxy ไปหา Express server ที่ 3000
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      '/webhook': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
