import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 生产构建期注入的 CSP（纵深防御，非现存漏洞的修补）。
 *
 * 只在 build 时注入，dev 不注入：HMR / 调试需要更宽松的环境（Vite dev 会注入内联脚本）。
 * 用 meta 而非响应头，是因为 GitHub Pages 无法自定义响应头；自托管时应改用响应头
 * （见 RELAY_DEPLOY.md「建议的响应头」）。
 *
 * `connect-src` 必须放行任意 http(s)：接收端在界面上填的 Relay 地址由用户决定，
 * 跨源调用是设计的一部分 —— 收紧成固定源会直接打死主功能。
 * `style-src` 保留 'unsafe-inline'：Vue 的 `:style` 绑定会写入 style 属性。
 */
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "object-src 'none'",
    "base-uri 'none'"
].join('; ')

const injectContentSecurityPolicy = () => ({
    name: 'coolector:inject-csp',
    apply: 'build' as const,
    transformIndexHtml: (html: string) => ({
        html,
        tags: [{
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
            injectTo: 'head-prepend' as const
        }]
    })
})

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue(), injectContentSecurityPolicy()],
    base: './',
    server: {
        // 放行 ngrok 隧道的 Host（否则经隧道访问 dev server 会被 Vite 403 拦截）。
        // ngrok 免费档的开发域名是 `*.ngrok-free.dev`（旧账号可能仍是 `*.ngrok-free.app`），
        // 付费静态域名是 `*.ngrok.app`，旧版为 `*.ngrok.io` —— 一并列出。
        // 注意：本项目推荐的形态（Pages 前端 + 单条 Relay 隧道）不经过 dev server，
        // 这里的白名单只在「把 5174 也单独穿透」时才起作用（见 RECEIVER_SETUP.md §8）。
        allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.app', '.ngrok.io']
        // 这里原有一个 `/relay` → 127.0.0.1:8787 的同源 dev 代理，随「VITE_RELAY_URL
        // 只认 http(s) 绝对地址」一并移除：它服务的那个值（`/relay`）已被三处判据一致拒绝。
        // 本机开发因此改为直连（前端填 http://127.0.0.1:8787，属跨源调用）：
        // `pnpm start` 会自动放行 http://localhost:5174 与 http://127.0.0.1:5174
        // （见 server/start.js 的 devAllowedOrigins）；只跑 `pnpm dev` + `pnpm relay` 时
        // 需在 .env 里自行设 RELAY_ALLOWED_ORIGINS=http://localhost:5174。
    },
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        // 生产不发 sourcemap：dist/ 会原样发布到公开的 GitHub Pages，
        // 带上 .map 等于公开全部 TS 源码（也降低了从产物里翻出敏感串的门槛）。
        // 需要线上排障时改成 'hidden' 并只把 .map 上传到私有错误监控。
        sourcemap: false
    },
    css: {
        devSourcemap: true
    }
})
