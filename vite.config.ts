import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    base: './',
    server: {
        proxy: {
            // 本地开发时把 /relay 转发到 Relay Server（默认 8787），
            // 配合 VITE_RELAY_URL=/relay 使用可走同源、免跨域直达本机服务。
            // 生产/公网场景仍用绝对地址（如 http://127.0.0.1:8787）。
            '/relay': {
                target: 'http://127.0.0.1:8787',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/relay/, '')
            }
        }
    },
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        sourcemap: true
    },
    css: {
        devSourcemap: true
    }
})
