# Relay Server 部署指南

Coolector 的「在线收集」能力由两部分组成：

- **前端**（静态站，可托管到 GitHub Pages / Nginx / 任意静态服务）
- **Relay Server**（`server/relay-server.js`，有状态 Node 服务，**必须自托管**才能公网可达）

仓库 CI 只部署静态前端；Relay Server 需要你按本文档自行部署到一台有公网 IP 的主机。

## 1. 前置要求

- Node.js 24+
- 一台有公网 IP 的服务器
- 一个域名（用于 TLS，可选但强烈建议）

## 2. 环境变量

> **完整清单以 [`.env.example`](./.env.example) 为唯一权威**（含默认值与逐项说明）。
> 这里只列部署时**必须当面确认**的几个，其余按默认值走即可。

| 变量                     | 默认值               | 说明                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_TOKEN`            | 空（关闭）           | 接收端管理密钥。设为非空后，除「发送方公开写」与 SSE 一次性票据外的所有 `/api` 请求需带 `Authorization: Bearer <token>`。**公网必填**                                                                                                                                            |
| `HOST`                   | `0.0.0.0`            | 监听地址。未设 `RELAY_TOKEN` 且非回环时**拒绝启动**（fail-closed）                                                                                                                                                                                                               |
| `RELAY_ALLOWED_ORIGINS`  | 空（不发 CORS 头）   | CORS 白名单，逗号分隔。**留空 = 拒绝所有跨源前端**（同源部署无需配置）；前后端不同源时必须显式填前端域名，`*` 只适合本机/内网。本机 `pnpm start` 会自动放行 `localhost:5174`                                                                                                     |
| `RELAY_PUBLIC_BASE_URL`  | 空（只输出相对路径） | 对外 URL 基址。**留空即可，反代 HTTPS 部署也一样**——接收端按它填写的 Relay 地址解析相对路径。服务端不会从 `Host` / `x-forwarded-*` 推断自身地址（那会让攻击者用伪造 `Host` 把接收端的管理密钥引向外部）。仅当有非浏览器客户端需要绝对 URL 时才设，如 `https://relay.example.com` |
| `RELAY_TRUSTED_PROXIES`  | 空（忽略转发头）     | 可信反向代理网段（IP/CIDR，逗号分隔）。**反代部署必须声明**，否则所有请求的 socket 地址都是代理 IP、全站共用一个限流桶 —— 单个滥用者足以让全班 429。例：`127.0.0.1,10.0.0.0/8`。直连部署留空（留空 = 不采信 `X-Forwarded-For`，防伪造换桶绕过限流）                              |
| `UPLOAD_DIR`             | `./server/uploads`   | 上传落盘目录，**生产务必指向持久磁盘上的专用目录**（见 §5 与 §6）                                                                                                                                                                                                                |
| `MAX_TOTAL_UPLOAD_BYTES` | `1073741824` (1GB)   | 全局磁盘配额，超出返回 **507**                                                                                                                                                                                                                                                   |
| `MAX_ROOM_UPLOAD_BYTES`  | 全局的 1/8（128MB）  | **单房间**配额。文本类作业为主时需调大一档（见 `.env.example` 的计费口径说明）                                                                                                                                                                                                   |

配额、体积、限流、生命周期等调优项（`MAX_FILE_BYTES` / `MAX_TEXT_BYTES` / `MAX_BODY_BYTES` /
`MAX_ROOM_UPLOADS` / `MAX_UPLOAD_NAME_BYTES` / `ROOM_TTL_MS` / `ROOM_MAX_LIFETIME_MS` /
`ROOM_CLEANUP_INTERVAL_MS` / `RELAY_KEEP_ORPHAN_UPLOADS` / `MAX_QUEUE_EVENTS` /
`RATE_LIMIT_*` / `MAX_UPLOAD_BYTES_PER_WINDOW` / `STREAM_TICKET_TTL_MS` /
`RELAY_TRUSTED_PROXIES`）见 `.env.example`。

所有变量均可选；未设置时走默认值。

> **数值型变量现在会 fail-closed 校验**：写成 `MAX_FILE_BYTES=10mb` 这类非整数会让进程**拒绝启动**，
> 而不是把 `NaN` 带进体积判断（那会让所有校验静默失效）。
> **重启会丢弃房间与上传文件**：房间只存在于内存，重启后旧房间一律 404（接收端需要重新建房并分享新的房间号）。
> 磁盘上残留的目录因此成为「无主目录」，服务默认在启动时回收它们并记入审计日志，
> 避免它们被永久计入配额、把磁盘占住却无法回收。若需要人工抢救，设
> `RELAY_KEEP_ORPHAN_UPLOADS=true`（此时它们仍计入配额）。
>
> **回收是可判定的**：每个房间目录在首次落盘时会写入归属标记 `.coolector-room`（内容含 roomId）。
> 启动回收**只删**「含该标记、且标记里的 roomId 与目录名一致」的目录；
> 无标记 / 标记损坏 / 标记不匹配的目录一律**不删、也不计入配额**，并在启动日志里逐条列出。
> 因此即使 `UPLOAD_DIR` 指向了共享数据根，也不会误删无关数据 —— 但仍**建议指向专用子目录**。
>
> ⚠️ **多实例禁令**：两个 relay 实例**不能**共享同一个 `UPLOAD_DIR`。新实例启动时会回收
> 它看到的所有「带标记目录」（含在跑实例的在线房间），把它们当作无主目录删掉。
> **房间创建**：`POST /api/rooms/:roomId/uploads` 是唯一的免凭据写入口（发送方用），
> 且**不会**自动创建房间 —— 房间必须由持有 `RELAY_TOKEN` 的接收端先创建。
> 房间 ID 默认是服务端生成的完整 UUID，长度下限 8 位；`demo-room` 这类弱房间名会记一条
> `weak_room_id` 审计日志。

## 3. 启动 Relay Server

Relay Server 是纯 Node、零第三方依赖的单进程服务，直接运行即可 —— **无需构建，也无需 `npm install`**：

```bash
cp .env.example .env         # 至少填写 RELAY_TOKEN 与 RELAY_ALLOWED_ORIGINS
node server/relay-server.js  # 前台运行，日志走 stdout/stderr

# 健康检查（应返回 {"status":"ok"}）
curl http://127.0.0.1:8787/healthz
```

- 生产应交给进程守护（`systemd` / `pm2` 等）托管，进程退出后自动拉起；`SIGTERM` 会直接结束进程，不保证上传落盘中途完成，重启前请先停止外部流量。
- 上传落盘目录由 `UPLOAD_DIR` 决定（默认 `./server/uploads`），**生产务必指向持久磁盘**，并确保运行用户对该目录有写权限（否则建房间目录时 `EACCES`）。
- ⚠️ **不要在公网直接暴露 8787**：Relay 自身不处理 TLS。应让它只监听回环/内网，由反向代理对外提供 HTTPS（见下一节）。

## 4. 反向代理（TLS）

Relay Server 本身不处理 TLS。生产应通过反向代理暴露 HTTPS。

**Relay 不读取 `X-Forwarded-Proto` / `Host` 等请求头来推断自己的对外地址。** 服务端对外**只输出相对路径**，由前端按界面填写（或构建期 `VITE_RELAY_URL`）的 Relay 地址解析。这样做是因为请求头由调用方任意控制，而接收端会自动带凭据去拉取服务端返回的 URL —— 一旦采信这些头，无凭据的发送方只要伪造 `Host`，就能让接收端把管理密钥发往攻击者域（已修复的 F-001）。因此反代侧**不需要**任何特殊配置，HTTPS 下也不存在混合内容问题。

反向代理只需满足四件事，本文不提供现成配置文件（各家代理语法差异大，照抄易漂移）：

| 要求 | 原因 |
| --- | --- |
| 终结 TLS（Caddy 可自动申请证书；Nginx 可配 certbot 或等价方案） | 前端与 Relay 都必须是 HTTPS，否则浏览器按混合内容拦掉 |
| **关闭响应缓冲**（Nginx 关 `proxy_buffering`；Caddy 默认即不缓冲） | 否则 SSE 事件被攒在代理里，接收端看起来「没有反应」 |
| 请求体上限 ≥ `MAX_BODY_BYTES`（默认派生 15,160,662 B ≈ 15.16 MB；Nginx 为 `client_max_body_size`） | 小于它时大文件会在到达 Relay 之前被代理截断，且报错来自代理、与 Relay 无关 |
| 代理会改写来源地址时，同时设置 `RELAY_TRUSTED_PROXIES` | 否则限流按代理 IP 计数，退化为全站单桶（见 §2 与 `.env.example`） |

`X-Forwarded-*` / `Host` 只对**代理自身的日志与访问控制**有意义：relay 不读取它们，生成绝对 URL 是客户端的事。

### 4.1 建议的响应头（托管侧）

GitHub Pages **无法自定义响应头**，因此前端产物里的 CSP 是以 `<meta>` 形式在构建期注入的
（见 `vite.config.ts` 的 `coolector:inject-csp`）。若你自托管前端（Nginx / 对象存储 / CDN），
请把这些头放到**响应头**里 —— 响应头比 meta 更强，且能覆盖 meta 做不到的项：

| 头                          | 值                                    | 说明                                                                         |
| --------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | 强制 HTTPS（前后端域名都加）                                                 |
| `X-Frame-Options`           | `DENY`                                | 防点击劫持；CSP 的 `frame-ancestors` 在 meta 里**不生效**，只能用响应头      |
| `X-Content-Type-Options`    | `nosniff`                             | Relay 的下载响应已自带，静态站建议一并加                                     |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`     | URL 里可能带 SSE 一次性票据，别随 Referer 外泄（`index.html` 已有同名 meta） |
| `Content-Security-Policy`   | 同 `vite.config.ts` 里的值            | 自托管时应迁到这里，并从 meta 移除，避免两处漂移                             |

> CSP 的 `connect-src` **必须**放行任意 http(s)：接收端填写的 Relay 地址是用户决定的，跨源是设计的一部分。

## 5. 前端生产构建

前端通过 `VITE_RELAY_URL` 在**构建期**注入 Relay 地址。生产必须设置，否则默认回退 `http://127.0.0.1:8787`（仅本机有效）。

```bash
# 方式 A：环境变量（构建命令前）
VITE_RELAY_URL=https://relay.example.com pnpm build

# 方式 B：写入 .env.production（构建时自动读取）
#   VITE_RELAY_URL=https://relay.example.com
pnpm build
```

构建产物 `dist/` 部署到任意静态托管（GitHub Pages、Nginx、对象存储等）。
前端 `Receiver` 与 `Sender` 届时连接 `https://relay.example.com`，跨域由 relay 的 `RELAY_ALLOWED_ORIGINS=https://app.example.com` 放行。

### 5.1 GitHub Pages + 独立 Relay（本项目默认形态）

前端在 `https://<org>.github.io/<repo>/`，Relay 在另一台机器/域名上。
**两边都要配，缺一边就是「站点能打开但连不上」**，而它的表现只是界面上一句连接失败。

**① 配构建期变量**（仓库 → Settings → Secrets and variables → Actions → Variables → New repository variable）

```bash
gh variable set VITE_RELAY_URL --repo <org>/<repo> --body 'https://relay.example.com'
gh variable list  --repo <org>/<repo>          # 确认

# 它是构建期注入的：改完必须重新构建部署才生效
gh workflow run deploy.yml --repo <org>/<repo>  # 或随便 push 一次
```

> **变量缺失时 `deploy.yml` 不会部署**：产物若内联不到 Relay 地址，就会静默回落到
> `http://127.0.0.1:8787` —— 那是**访问者自己的机器**，页面能打开、却谁也连不上。
> 因此这时工作流直接**跳过**发布（线上保持上一版）并在运行摘要里写明原因，既不发布废产物，
> 也不把流水线打红（本项目的 Relay 是「本机 + 隧道」形态，长期没有稳定域名，飘红只会训练人忽略红色）。
> 变量**存在但形态非法**时仍然直接失败（见下方「三条最容易踩的」）。

**② 让 Relay 放行 Pages 的源**

```bash
# .env（relay 进程启动时读取）
RELAY_TOKEN=<强随机值>
RELAY_ALLOWED_ORIGINS=https://<org>.github.io
```

三条最容易踩的：

- 填的是**源**（scheme + host + port），**不带路径、不带结尾斜杠**。Pages 站点虽然挂在 `/coolector/` 子路径下，
  但浏览器发的 `Origin` 头永远是 `https://<org>.github.io`；写成 `https://<org>.github.io/` 或带路径都匹配不上。
- Pages 是 HTTPS，Relay **也必须是 HTTPS**：`https://` 页面请求 `http://` Relay 会被浏览器按混合内容拦掉。
- **同源部署**（静态产物与 Relay 挂在同一个域名下）**不需要**配 `RELAY_ALLOWED_ORIGINS` —— 同源请求不涉及 CORS。

**③ 验证（两步都过才算通）**

```bash
# 产物里内联的地址是生产地址，而不是 127.0.0.1
grep -o 'https://relay.example.com' dist/assets/index-*.js | head -1

# Relay 确实放行了该源（应回显这个源；回显 * 说明你还没收窄，什么都不回说明没匹配上）
curl -s -D- -o /dev/null -H 'Origin: https://<org>.github.io' https://relay.example.com/healthz \
  | grep -i 'access-control-allow-origin'
```

> 推荐「子域」模式：`relay.example.com` 独立反代 relay，`app.example.com` 托管前端。
> 同域挂子路径同样可行，但地址**必须写成绝对形式**：`VITE_RELAY_URL=https://app.example.com/relay`，
> 反代把 `/relay/*` 重写到 relay 的根路径。relay 自身不感知前缀，前缀由反代剥掉。
> **不能**写成裸相对路径 `/relay` —— CI 门禁（`deploy.yml` 的 `Validate VITE_RELAY_URL`）、
> `pnpm guard:no-secret` 与前端运行期校验三处判据一致，都只接受 http(s) 绝对地址，
> 相对写法会在发布链路上被直接拒绝。

## 6. 安全清单（公网必做）

- [ ] `RELAY_TOKEN` 设为强随机值；前端调用 `/api` 时携带 `Authorization: Bearer <token>`
- [ ] `RELAY_ALLOWED_ORIGINS` 显式设为前端域名（如 `https://app.example.com`）；留空即拒绝所有跨源，`*` 只适合本机/内网
- [ ] 反向代理强制 HTTPS（HSTS 可选）
- [ ] `UPLOAD_DIR` 指向持久磁盘上的专用目录，并设合理的 `MAX_TOTAL_UPLOAD_BYTES` 防磁盘写满
- [ ] 服务器防火墙只放行 443（反代）与必要的 22；8787 不必对外暴露（由反代转发）

## 7. 持久化与运维

- **上传文件**：存于 `UPLOAD_DIR`，生产应指向持久磁盘；房间 `ROOM_TTL_MS` 过期后自动删除并回收配额。
- **房间状态**：存于内存，进程重启即清空（已落盘文件仍在 `UPLOAD_DIR`）。单实例足够；多实例不共享状态（无 Redis/DB），需扩展时请引入外部存储。
- **日志**：stdout/stderr，前台运行直接看终端；交给进程守护托管时看它自己的日志收集。
- **升级**：拉取新代码后重启进程即可 —— 服务端无构建步骤、无第三方依赖，不需要任何安装动作。**先摘流量再重启**：房间只存在于内存，重启后旧房间号一律 404，接收端必须重新建房并把新房间号发给发送方。
- **回滚（重要）**：**不要**用 `git revert` 回退 F-001 那一批修复 —— 它会原样复活 Critical（服务端重新输出
  `http://evil.example/...`，接收端把管理密钥送进攻击者域）。且**部分回滚双向有害**：只回退前端 → 相对路径会打到静态站自己身上（功能崩）；
  只回退服务端 → 前端第二道防线失去上游配合。正确处置是**前滚修复**；确实必须临时降级时，前后端必须**整批**回退到同一版本，
  并**同时轮换 `RELAY_TOKEN`**（该窗口内密钥应视为可被劫持）。
- **停服**：结束进程即可（`Ctrl-C` 或向进程发 `SIGTERM`）；上传文件留在 `UPLOAD_DIR`，不随进程退出删除。若要连文件一起清空，需自行删除 `UPLOAD_DIR` 下的房间目录。

## 8. 本地开发（不走公网）

```bash
pnpm install
pnpm start          # 同时启动前端(5174) + relay(8787)，前端默认连 127.0.0.1:8787
```

或单独起 relay：`pnpm run relay`。
