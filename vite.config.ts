import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { demoHealth } from './scripts/demo-health.mjs';
import { deepSeekProxy } from './scripts/deepseek-proxy.mjs';
export default defineConfig({
  plugins: [vue(), demoHealth(), deepSeekProxy()],
  server: {
    host: '127.0.0.1',
    watch: { ignored: ['**/.qa/**', '**/.delivery/**', '**/test-results/**', '**/.pnpm-store/**'] },
  },
  preview: { host: '127.0.0.1' },
  // Prebundle lazy chart and video imports so opening a panel does not reload the page.
  // Limit discovery to the real entry; ignored historical QA pages are not inputs.
  optimizeDeps: {
    entries: ['index.html'],
    include: [
      'mp4box',
      '@ffmpeg/ffmpeg',
      '@mediapipe/tasks-vision',
      'echarts/core',
      'echarts/charts',
      'echarts/components',
      'echarts/renderers',
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const module = id.replaceAll('\\', '/');
          if (module.includes('/element-plus/')) return 'ui';
          if (module.includes('/echarts/') || module.includes('/zrender/')) return 'charts';
          if (module.includes('/@mediapipe/tasks-vision/')) return 'vision';
        },
      },
    },
  },
});
