/// <reference types="vite/client" />

/**
 * 只声明可安全内联进产物的构建期变量。
 *
 * ⚠️ 刻意不提供 `VITE_RELAY_TOKEN`：管理密钥一旦经 Vite 构建期注入，
 * 就会被内联进公开的 `dist/` 产物，等于把接收端凭据发给每个发送方。
 * 密钥改由用户在界面上填写并保存在本机 localStorage（见 src/utils/relay.ts）。
 */
interface ImportMetaEnv {
  /** 前端连接 Relay 的地址；生产静态部署时必须设置，否则回退到本地默认 */
  readonly VITE_RELAY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
