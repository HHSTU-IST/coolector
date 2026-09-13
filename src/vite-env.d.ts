/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 前端连接 Relay 的地址；生产静态部署时必须设置，否则回退到本地默认 */
  readonly VITE_RELAY_URL?: string
  /** 前端调用 Relay 的鉴权令牌（与 Relay 端 RELAY_TOKEN 一致） */
  readonly VITE_RELAY_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
