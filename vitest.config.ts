import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    // shared/ 是被前后端共同引用的判据模块，测试随实现同目录存放
    include: ['src/**/*.test.ts', 'server/**/*.test.js', 'shared/**/*.test.js']
  }
})
