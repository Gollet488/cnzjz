import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { demoHealth } from './scripts/demo-health.mjs';
import { deepSeekProxy } from './scripts/deepseek-proxy.mjs';
export default defineConfig({
  plugins: [vue(), demoHealth(), deepSeekProxy()],
  server: {
    host: '127.0.0.1',
    watch: { ignored: ['**/.qa/**', '**/.delivery/**', '**/test-results/**'] },
  },
  preview: { host: '127.0.0.1' },
  // Prebundle worker-only MP4 and lazy FFmpeg imports before the first upload.
  // Limit discovery to the real entry; ignored historical QA pages are not inputs.
  optimizeDeps: { entries: ['index.html'], include: ['mp4box', '@ffmpeg/ffmpeg'] },
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
