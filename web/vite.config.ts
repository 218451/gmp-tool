import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    host: true, // 允许手机同局域网访问（现场审核场景）
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
