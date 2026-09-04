import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    base: './',
    server: {
        proxy: {
            // dev 时把 /relay 转发到本机 Relay，配合 VITE_RELAY_URL=/relay 走同源；生产用绝对地址
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
