# Coolector

![typescript](https://img.shields.io/badge/typescript-6.0+-blue.svg)
![vue](https://img.shields.io/badge/vue-3.5+-brightgreen.svg)
![pinia](https://img.shields.io/badge/pinia-3.0+-ff6b6b.svg)
![vite](https://img.shields.io/badge/vite-8.0+-yellow.svg)
![tailwind](https://img.shields.io/badge/tailwind-4.0+-38bdf8.svg)

Coolector 是一个现代化的文件收集器。

## 主要功能

- [x] 文件上传
  - [x] 支持 .md, .ipynb, .docx
    - [x] .docx 自动解压读取正文，原始文件字节完整保留
  - [x] 支持批量上传
- [x] 拖拽上传和点击上传
- [x] 文件名校验
  - [x] 自定义文件名范式
  - [x] 校验文件名是否符合要求
- [x] 自动化文件信息提取
  - [x] 文件大小、类型、应用记录时间
  - [x] 从文件名中提取学号、姓名等信息
- [x] 读取收集名单并检查提交状态
- [x] 响应式设计
  - [x] 支持网页端
  - [x] 支持移动端

## 技术栈

- **前端框架**: Vue.js 3.5 (Composition API)
- **编程语言**: TypeScript 6.0+
- **状态管理**: Pinia 3.0+
- **构建工具**: Vite 8.0+
- **样式框架**: Tailwind CSS 4.0+
- **UI 组件**: 自定义组件 + Tailwind 工具类

## 开发指南

### 环境要求

- Node.js >=24.0
- pnpm >= 11.21.0

### 安装依赖

```bash
pnpm install
```

### 开发服务器

```bash
pnpm run dev
```

应用将在 <http://localhost:5174> 启动

### 快速启动前端和 Relay

```bash
pnpm start
```

默认同时启动：

- 前端应用：<http://localhost:5174>
- Relay Server：<http://localhost:8787>

可通过环境变量自定义端口：

```bash
APP_PORT=3000 RELAY_PORT=9000 pnpm start
```

### 构建项目

```bash
pnpm run build
```

构建产物将输出到 `dist/` 目录

### 预览构建结果

```bash
pnpm run preview
```

### 测试与门禁

改完代码请跑完整门禁；CI 会执行同一组命令。

```bash
pnpm test                # 单元测试（vitest）
pnpm lint                # oxlint，要求 0 warning / 0 error
pnpm exec vue-tsc -b     # 类型检查（pnpm build 已包含）
pnpm build               # 生产构建
pnpm guard:no-secret     # 断言构建产物中不含任何密钥（需先 build）
pnpm e2e                 # 真实浏览器端到端回归（会先 build）
```

`pnpm e2e` 需要本机有 Chromium：`pnpm exec playwright install chromium`，
或用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已有的浏览器路径。
**它默认不会静默跳过** —— 静默跳过的门禁等于没有门禁；确实无法提供浏览器时，
可显式设置 `E2E_ALLOW_SKIP=1`。

> 为什么必须有浏览器回归：curl 不做请求头的 ISO-8859-1 校验，
> 因此「中文文件名让浏览器 `fetch` 在出网前抛 TypeError」这类主路径缺陷，
> 用 curl 冒烟是**必然看不见**的。`scripts/e2e-upload.mjs` 专门覆盖这条链路。

### 启动 Relay Server

```bash
pnpm run relay
```

默认监听 `http://localhost:8787`

## 项目结构

```text
server/
├── relay-server.js     # Relay 主服务（Node 原生 http，零第三方运行时依赖）
├── relay-utils.js      # 抽出的纯函数（可单测）
├── relay-utils.test.js # 纯函数单测
└── start.js            # web + relay 双进程编排
scripts/
├── e2e-upload.mjs      # 真实浏览器端到端回归（G3 门禁）
├── check-no-secrets.mjs# 构建产物密钥泄露守卫
└── receiver.mjs        # 内网穿透一键编排（本机当接收端）
src/
├── components/          # Vue 组件
│   ├── FileUploader.vue    # 文件上传组件
│   ├── CollectionStatus.vue # 收集状态组件
│   ├── FileViewer.vue      # 文件预览 / 发送方上传
│   ├── RelayReceiver.vue   # 公网接收长连接（SSE）
│   └── ToastHost.vue       # 全局提示宿主
├── stores/             # Pinia 状态管理
│   ├── file.ts         # 文件相关状态
│   └── collection.ts   # 收集列表状态
├── utils/              # 工具函数（文件名解析、docx 解析、格式化、relay 凭据）
├── composables/        # 组合式函数（useToast）
├── App.vue            # 根组件
├── main.ts            # 应用入口
└── style.css          # 全局样式
```

## 核心功能

### 文件上传

- [x] 支持拖拽上传和点击上传
- [x] 支持多文件同时上传
- [x] 显示文件大小、类型等信息

### 收集名单管理

- [x] 上传包含文件名的列表文件
- [x] 实时跟踪收集进度
- [x] 状态标记：待收集、已收集、错误
- [x] 可视化进度条显示

### 文件预览

- [x] 查看上传文件的内容
- [x] 标记文件为已收集状态
- [x] 显示文件详细信息

## 跨公网传输

- [x] 公网 Relay Server
- [x] Receiver 长连接
- [x] HTTP 上传
- [x] Relay 内存转发
- [x] 服务端保存并下载客户端上传文件

Relay 收到客户端上传后会把文件保存到 `server/uploads/<roomId>/`，并返回可下载地址：

```text
GET /api/rooms/:roomId/uploads/:uploadId?download=1
```

也可以通过房间状态查看上传文件和下载链接（需携带接收端密钥）：

```bash
curl -H "Authorization: Bearer $RELAY_TOKEN" http://localhost:8787/api/rooms/<roomId>
```

### 鉴权模型（重要）

- **接收端**持有管理密钥 `RELAY_TOKEN`：建房、查状态、签发 SSE 票据、删除房间都需要它。
  密钥**只保存在浏览器本机 `localStorage`**，由用户在「公网接收长连接」面板填写，绝不随前端产物分发。
- **发送方不需要任何密钥**：只需知道房间号即可上传。房间号是服务端生成的完整 UUID，
  **它本身就是能力凭据**，因此不要公开张贴 —— 只说给该交作业的人。
- **SSE 不回退到 URL token**：`EventSource` 无法自定义请求头，接收端先用
  `POST /api/rooms/:roomId/stream-ticket` 换一次性短时效票据（默认 60 秒、用后即焚）。

> 变更影响：`POST /api/rooms/:roomId/uploads` 不再「上传即建房」。房间必须由接收端先创建，
> 否则上传返回 404 —— 过去发送方落进没有接收端的房间等于进了黑洞，且允许自造房间号无限建房。
> 升级顺序建议 **先前端后 Relay**（新前端会带 `X-Relay-Envelope` 标志，旧 Relay 也能正确解析）。

> **公网部署**：Relay Server 是有状态服务，CI 只部署静态前端，**需自行托管才能公网可达**。
> 完整部署清单（Docker / 反向代理 / 环境变量 / 安全）见 [RELAY_DEPLOY.md](./RELAY_DEPLOY.md)。
> 部署到公网时务必设置 `RELAY_TOKEN` 与 `RELAY_ALLOWED_ORIGINS`，强制 HTTPS，
> 并开启 `RELAY_TRUST_PROXY=true`（否则回调地址是 `http://`，浏览器会拦截混合内容）。
> **未设置 `RELAY_TOKEN` 且监听非回环地址时，Relay 会拒绝启动（fail-closed）**；
> `pnpm start` 在这种情况会**强制**把 relay 回退到 `127.0.0.1` 并打印提示，
> 因此新克隆仓库直接 `pnpm start` 即可本地跑起来，不会整栈退出。

### 运行期语义（务必知悉）

- **房间与上传都只存在于内存 / 本地磁盘，重启即失效**：重启后旧房间一律 404，
  接收端需要重新建房并把新的房间号发给发送方。服务启动时会回收磁盘上残留的
  「无主上传目录」（`RELAY_KEEP_ORPHAN_UPLOADS=true` 可改为保留），
  否则它们会被永久计入磁盘配额却无法回收。
- **配额按房间计**（`MAX_ROOM_UPLOAD_BYTES`，默认全局的 1/8）：
  免凭据的发送方只能填满自己那个房间，不会把全局配额吃光导致其它班级一起失败。
  计费口径是「正文 + 元数据 + 服务端保留的文本字段」，文本类文件约为文件大小的 2 倍。
- **房间有绝对存活上限**（`ROOM_MAX_LIFETIME_MS`，默认 24h），即使接收端一直连着也会到点回收。

## 使用说明

1. **上传文件**: 点击或拖拽文件到上传区域
2. **上传收集名单**: 上传包含目标文件名的文本文件
3. **查看收集状态**: 实时查看收集进度和状态
4. **预览文件**: 点击文件查看详细内容
5. **标记完成**: 在文件预览中标记为已收集

## 开发特性

- 🎯 完整的 TypeScript 类型支持
- 🎨 现代化的响应式设计
- ⚡ 快速的开发体验（Vite HMR）
- 📱 移动端友好的界面
- 🔧 模块化的组件架构
- 📊 实时的状态管理
