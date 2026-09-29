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
    - [x] .docx 由服务端解包读取正文，原始文件字节完整保留
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
pnpm check:atomic        # 并发不变量：配额/槽位的检查与扣减之间不得出现 await
pnpm exec vue-tsc -b     # 类型检查：src/ + vite.config.ts + server/ + shared/（pnpm build 已包含）
pnpm build               # 生产构建
pnpm guard:no-secret     # 断言构建产物中不含任何密钥（需先 build）
pnpm e2e                 # 真实浏览器端到端回归（会先 build）
```

`server/` 与 `shared/` 是原生 JavaScript，由 `tsconfig.server.json` 的 `checkJs` + `strict` 纳入
类型检查（生产代码全量受检；测试文件暂未纳入，理由见该配置内的注释）。因此给服务端函数补
JSDoc `@param` / `@returns` 是这条门禁的要求，而不是可选修饰。

`pnpm check:atomic` 是**本项目唯一反复复发的缺陷类**（配额 TOCTOU，曾把 4MB 房间打到 8.39×）
的可执行防线：它用 TypeScript 编译器 API 解析 `server/relay-state.js`，断言
`reserveStorageQuota` / `reserveUploadSlot` 的 JSDoc 带 `@atomic`、函数自身作用域内没有
`await`、且配额计数字段只在白名单函数里被写入。规则与判别力测试见
`scripts/check-atomic-invariants.mjs` 与 `server/relay-atomic-invariants.test.js`。

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

## 软件架构

> 下图由 Mermaid 渲染，GitHub 与 VS Code 均原生支持；需要导出图片时可用 `mermaid-cli`。

### 组件与信任边界

```mermaid
flowchart TB
  subgraph client["浏览器 · 纯静态前端（GitHub Pages / 任意静态托管，产物不含任何密钥）"]
    direction TB
    sender["发送方页面<br/>FileUploader · FileViewer"]
    receiver["接收端页面<br/>RelayReceiver（SSE 长连接）"]
    core["Pinia stores + utils/relay<br/>file · collection · 地址校验 · 同源解析<br/>RELAY_TOKEN 只存 localStorage"]
    sender --> core
    receiver --> core
  end

  subgraph edge["反向代理（可选）· Caddy / Nginx"]
    tls["HTTPS 终结<br/>反代头既不需要、也无法左右对外 URL"]
  end

  subgraph srv["Relay Server · 自托管 Node 进程 · 零第三方运行时依赖"]
    direction TB
    app["relay-server.js<br/>路由分发 + 各 handler（唯一编排层）"]
    roomState["relay-state.js<br/>房间 · 配额原子预占 · 生命周期"]
    http["relay-http.js<br/>CORS · 鉴权 · 限流 · SSE 原语"]
    conf["relay-config.js<br/>环境变量解析（非法即拒绝启动）"]
    utils["relay-utils.js<br/>纯函数（可单测）"]
    app --> roomState
    app --> http
    roomState --> http
    http --> conf
    conf --> utils
  end

  disk["UPLOAD_DIR · server/uploads/房间号/<br/>正文 + room.json（房间元数据）"]

  sender -->|"POST /api/rooms/:roomId/uploads（免凭据）"| tls
  receiver -->|"Bearer 密钥：建房 · 换 SSE 票据 · 按需拉正文"| tls
  tls --> app
  roomState -->|"落盘 / 重启恢复"| disk
```

三条结构性事实（也是全部安全设计的来源）：

1. **前端是纯静态站**：`dist/` 可直接公开托管，接收端密钥由用户在界面上填写、只存本机 `localStorage`，
   因此产物永远是公开安全的（`pnpm guard:no-secret` 会断言这一点）。
2. **Relay Server 是唯一有状态方**：房间与上传元数据落磁盘（每个房间目录一个 `room.json`），
   正文只落磁盘、内存不留副本；无 Redis / 无数据库 / 无第三方运行时依赖，重启后按元数据恢复房间与作业，
   单实例即可服务多个班级，但也**不支持多实例共享 `UPLOAD_DIR`**。
3. **服务端只输出相对路径**：`Host` / `X-Forwarded-*` 完全不参与 URL 拼接，由客户端按自己填写的 Relay 地址解析 ——
   否则无凭据的发送方伪造 `Host` 就能把接收端的管理密钥引向攻击者域。

### 两条主链路

```mermaid
sequenceDiagram
  autonumber
  participant S as 发送方浏览器
  participant R as 接收端浏览器
  participant Relay as Relay Server

  Note over R,Relay: ① 接收端建房并挂上长连接（需 Bearer 密钥）
  R->>Relay: POST /api/rooms（房间号可留空，由服务端生成 UUID）
  Relay-->>R: roomId · stateUrl · streamUrl（全是相对路径）
  R->>Relay: POST /api/rooms/:roomId/stream-ticket
  Relay-->>R: 一次性票据（默认 60s · 用后即焚）
  R->>Relay: GET /api/rooms/:roomId/events?ticket=…
  Relay-->>R: 打开即补发 receiver.ready，并重放离线队列

  Note over S,Relay: ② 发送方上传（不需要任何密钥，房间号即能力凭据）
  S->>Relay: POST /api/rooms/:roomId/uploads（裸 body + ?name=）
  Relay->>Relay: 体积校验 → 原子预占房间配额与条数上限
  Relay->>Relay: 落盘正文到 UPLOAD_DIR/房间号/，并把房间元数据写进 room.json
  Relay-->>S: 201（只回元信息，不含正文）
  Relay-->>R: SSE upload.created（只带元信息，不含正文）

  Note over R,Relay: ③ 接收端按需把正文拉回来（Bearer）
  R->>Relay: GET detailsUrl
  Relay-->>R: 文本类回文本，二进制回 base64（含 textTruncated 标记）
```

> 为什么 SSE 只推元信息：单文件上限 10 MB，正文广播会按接收端数量成倍放大内存与流量；
> 正文一律走 `detailsUrl` 按需拉取，`download` 端点则直接从磁盘读回。
>
> **201 与 SSE 广播口径一致：只回元信息，不含正文**。发送方刚把这些字节发上来，回显只是让它
> 再下载一遍 —— 实测一次 10 MB 上传在回显形态下往返 **24.47 MB**（上行 10.49 + 下行 13.98），
> 响应比请求还大；去掉回显后往返降到 **10.49 MB**，服务端单次上传的峰值内存从 **43.4 MB**
> 降到 **10.1 MB**。文本类文件另有 1 MB 的 `contentText` 一层，同样已去掉。
> 需要正文的一方（只有接收端）走 `detailsUrl`，它需要 Bearer 凭据。

## 项目结构

```text
server/
├── relay-server.js     # Relay 主服务：路由分发与各 handler（Node 原生 http）
├── relay-config.js     # 环境变量解析（非法值 fail-closed 退出）
├── relay-http.js       # HTTP 原语与准入（CORS / 鉴权 / 限流 / 读写）
├── relay-state.js      # 房间状态、配额记账与生命周期
├── *.test.js           # 纯函数单测 + 真实进程 HTTP 集成测试
└── start.js            # web + relay 双进程编排
scripts/
├── e2e-upload.mjs              # 真实浏览器端到端回归（G3 门禁）
├── check-no-secrets.mjs        # 构建产物密钥泄露守卫
├── check-atomic-invariants.mjs # 并发不变量 AST 静态检查
└── lib/                        # e2e 夹具（docx 生成器等）
src/
├── components/          # Vue 组件
│   ├── FileUploader.vue    # 文件上传组件
│   ├── CollectionStatus.vue # 收集状态组件
│   ├── FileViewer.vue      # 文件预览 / 发送方上传
│   ├── RelayReceiver.vue   # 公网接收长连接（SSE）
│   └── ToastHost.vue       # 全局提示宿主
├── composables/        # 组合式函数（useToast / useRelayReceiver）
├── stores/             # Pinia 状态管理（file / collection）
├── utils/              # 文件名解析、格式化、relay 凭据与契约类型、上传请求构造
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

### 上传请求的两种形态

`POST /api/rooms/:roomId/uploads` 接受两种请求体：

- **裸 body**：正文即文件原始字节，元信息走 URL 或请求头。**不做任何 base64**
  —— 相比信封省掉 33% 带宽与客户端主线程上的编码开销。**内置前端只用这一种形态**。
- **JSON 信封**：元信息与 base64 正文都在 body 里，须**显式**带 `X-Relay-Envelope: 1`
  —— 否则正文本身就是 JSON 的 `.json` / `.ipynb` 会被误判成信封。
  这条通道**仅为第三方/自定义客户端保留**（服务端仍然支持并有测试守着）；
  内置前端自 1.0.2 起不再使用它 —— 见下方「为什么前端不再用信封」。

`.docx` 的正文提取在**服务端**完成（`server/relay-docx.js`：ZIP 中央目录解析 +
`zlib.inflateRawSync`，零新依赖）：客户端把 docx 当普通二进制文件上传，服务端从收到的字节里
解出正文供预览，**原始包字节原样落盘**（`?download=1` 拿到的永远是原件）。

裸 body 形态的文件名以 **`?name=<百分号编码的 UTF-8>` 为准**，其次才是 `X-Relay-Filename` 头：

```bash
# %E4%BD%9C%E4%B8%9A.docx 即「作业.docx」
curl -X POST "http://localhost:8787/api/rooms/<roomId>/uploads?name=%E4%BD%9C%E4%B8%9A.docx" \
  --data-binary @作业.docx
```

> HTTP 头值只接受 ISO-8859-1，所以 `X-Relay-Filename` 只适合 curl 直接写 UTF-8 字节的形态。
> 该头**也**接受百分号编码，但**仅当解出来确实含非 ASCII 字符时**才解码 ——
> `note%20f.md` 这类纯 ASCII 的 `%XX` 原样保留，不会被人为改成另一个文件名。
> 文件名里**本来就含** `%XX` 时，用 `?name=` 写双重编码（`note%2520f.md`）精确表达。

#### 为什么前端不再用信封

信封此前有两个非它不可的理由，**两个都已消除**：

| 理由                                                       | 消除方式                                               |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `.docx` 的客户端提取正文没有位置放（裸 body 只有文件字节） | 正文提取移到服务端 ⇒ docx 与普通文件同路径             |
| 中继接收来的文件本地只剩 base64，没有原始字节              | 上传前在本地做一次 base64 → Blob 转换 ⇒ 同样有字节可发 |

信封一旦只为一个冷门场景留着，它就会长期躺在主路径上被误用（上一轮协议形态反复的成因）。
现在前后端都只剩一种传输形态，`X-Relay-Envelope` 不再是任何主路径的一部分。

### 鉴权模型（重要）

- **接收端**持有管理密钥 `RELAY_TOKEN`：建房、查状态、签发 SSE 票据、删除房间都需要它。
  密钥**只保存在浏览器本机 `localStorage`**，由用户在「公网接收长连接」面板填写，绝不随前端产物分发。
- **发送方不需要任何密钥**：只需知道房间号即可上传。房间号是服务端生成的完整 UUID，
  **它本身就是能力凭据**，因此不要公开张贴 —— 只说给该交作业的人。
- **SSE 不回退到 URL token**：`EventSource` 无法自定义请求头，接收端先用
  `POST /api/rooms/:roomId/stream-ticket` 换一次性短时效票据（默认 60 秒、用后即焚）。

> 变更影响：`POST /api/rooms/:roomId/uploads` 不再「上传即建房」。房间必须由接收端先创建，
> 否则上传返回 404 —— 过去发送方落进没有接收端的房间等于进了黑洞，且允许自造房间号无限建房。
> 升级顺序建议 **先前端后 Relay**：新前端默认走裸 body 且不带凭据，旧 Relay 本来就支持这条通道
> （`?name=` 由 `URLSearchParams` 解码），因此不会出现「前端已升级、上传全失败」的窗口；
> 反向（先 Relay 后前端）同样安全。
> **公网部署**：Relay Server 是有状态服务，CI 只部署静态前端，**需自行托管才能公网可达**。
> 完整部署清单（反向代理 / 环境变量 / 安全）见 [RELAY_DEPLOY.md](./RELAY_DEPLOY.md)。
> 部署到公网时务必设置 `RELAY_TOKEN` 与 `RELAY_ALLOWED_ORIGINS`，并强制 HTTPS。
> 反代后**无需**任何额外配置：服务端对外只返回相对路径，接收端按它自己填写的 Relay 地址
> 解析，因此不会出现混合内容。服务端刻意**不**从 `Host` / `x-forwarded-*` 推断自身地址
> （那会让无凭据的发送方用伪造 `Host` 把接收端的管理密钥引向攻击者域）。
> 仅当有非浏览器客户端需要绝对 URL 时才设 `RELAY_PUBLIC_BASE_URL`。
> **未设置 `RELAY_TOKEN` 且监听非回环地址时，Relay 会拒绝启动（fail-closed）**；
> `pnpm start` 在这种情况会**强制**把 relay 回退到 `127.0.0.1` 并打印提示，
> 因此新克隆仓库直接 `pnpm start` 即可本地跑起来，不会整栈退出。

### 运行期语义（务必知悉）

- **重启不丢作业**：每个房间目录内有一个 `room.json` 保存房间与上传的元数据（文件名、类型、时间、
  预览文本、配额占用），服务启动时据此重建房间并**逐字节复原**磁盘配额占用。元数据引用的正文若已不在
  磁盘上，只跳过该条记录，其余照常恢复。正文本身从不写进元数据 —— 它是落盘字节的纯函数，
  接收端按需从磁盘重新推导，因此同一份作业在重启前后拿到的正文完全一致。
- **启动恢复只读不删**：没有 `room.json`（或元数据损坏 / 与目录名不符）的目录一律**跳过并告警**，
  既不删除也不计入配额 —— 因此 `UPLOAD_DIR` 即使指向共享数据根也不会误删无关数据。
  代价是这类目录需要人工清理，启动日志会把它们列出来。
- **房间仍受存活上限约束**：`createdAt` 一并持久化，因此绝对存活上限（`ROOM_MAX_LIFETIME_MS`，
  代码常量、默认 24h）在重启后依然有效，即使接收端一直连着也会到点回收。
  （一个推论：删除房间时若磁盘删除失败，下次启动会把它恢复出来 —— 作业确实还在，
  恢复比悄悄丢掉更符合「不误删」；若它已过期，下一轮清理会立即再尝试删除。）
- **配额按房间计**（`MAX_ROOM_UPLOAD_BYTES`，代码常量、默认取全局配额的 1/8）：
  免凭据的发送方只能填满自己那个房间，不会把全局配额吃光导致其它班级一起失败。
  计费口径是「正文 + 元数据 + 服务端保留的文本字段」，文本类文件约为文件大小的 2 倍。
- **多实例不能共享 `UPLOAD_DIR`**：新实例启动时会把该目录下的房间**全部恢复**到自己内存里
  （包括在跑实例正在服务的房间），两个实例于是各自独立记账、各自覆盖同一份 `room.json`，
  状态必然互相打架。需要横向扩展时，请让每个实例使用独立的 `UPLOAD_DIR`。
- **env 只负责运维形态，调参在代码里**：能通过环境变量配置的只有 9 项 —— `PORT` / `HOST` /
  `UPLOAD_DIR` / `RELAY_TOKEN` / `RELAY_ALLOWED_ORIGINS` / `RELAY_PUBLIC_BASE_URL` /
  `RELAY_TRUSTED_PROXIES` / `MAX_FILE_BYTES` / `MAX_TOTAL_UPLOAD_BYTES`（清单与默认值见
  [`.env.example`](./.env.example)）。其余 15 项内部调参（上文出现的 `ROOM_*` /
  `MAX_ROOM_*` / `MAX_TEXT_BYTES` / `RATE_LIMIT_*` 等）是 `server/relay-config.js` 的模块常量，
  **改 `.env` 不再生效** —— 它们互相耦合（请求体上限由 `MAX_FILE_BYTES` + 正文上限派生、房间配额
  取全局的 1/8、TTL 与清理周期必须协调），逐项暴露只会制造「改了一个、另一个没跟上」的错配
  （实测过一次：只调大 `MAX_FILE_BYTES` 而没重算派生上限，带提取正文的 docx 有效上限掉到约
  8.55MB）。要改就改 `TUNING_DEFAULTS`；测试或临时覆盖走唯一的显式通道 `RELAY_TUNING`（JSON），
  未知键与非法值一律拒绝启动。

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
