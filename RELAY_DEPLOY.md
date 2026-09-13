# Relay Server 部署指南

Coolector 的「在线收集」能力由两部分组成：

- **前端**（静态站，可托管到 GitHub Pages / Nginx / 任意静态服务）
- **Relay Server**（`server/relay-server.js`，有状态 Node 服务，**必须自托管**才能公网可达）

仓库 CI 只部署静态前端；Relay Server 需要你按本文档自行部署到有公网 IP 的主机 / 容器。

## 1. 前置要求

- Node.js 24+（或 Docker，推荐）
- 一台有公网 IP 的服务器（或容器平台）
- 一个域名（用于 TLS，可选但强烈建议）

Relay Server 是纯 Node、零第三方依赖，无需 `npm install`。

## 2. 环境变量

> **完整清单以 [`.env.example`](./.env.example) 为唯一权威**（含默认值与逐项说明）。
> 这里只列部署时**必须当面确认**的几个，其余按默认值走即可。

| 变量                     | 默认值               | 说明                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_TOKEN`            | 空（关闭）           | 接收端管理密钥。设为非空后，除「发送方公开写」与 SSE 一次性票据外的所有 `/api` 请求需带 `Authorization: Bearer <token>`。**公网必填**                                                                                                                                            |
| `HOST`                   | `0.0.0.0`            | 监听地址。未设 `RELAY_TOKEN` 且非回环时**拒绝启动**（fail-closed）                                                                                                                                                                                                               |
| `RELAY_ALLOWED_ORIGINS`  | 空（不发 CORS 头）   | CORS 白名单，逗号分隔。**留空 = 拒绝所有跨源前端**（同源部署无需配置）；前后端不同源时必须显式填前端域名，`*` 只适合本机/内网。本机 `pnpm start` 会自动放行 `localhost:5174`                                                                                                     |
| `RELAY_PUBLIC_BASE_URL`  | 空（只输出相对路径） | 对外 URL 基址。**留空即可，反代 HTTPS 部署也一样**——接收端按它填写的 Relay 地址解析相对路径。服务端不会从 `Host` / `x-forwarded-*` 推断自身地址（那会让攻击者用伪造 `Host` 把接收端的管理密钥引向外部）。仅当有非浏览器客户端需要绝对 URL 时才设，如 `https://relay.example.com` |
| `UPLOAD_DIR`             | `./server/uploads`   | 上传落盘目录，**生产务必挂持久卷**                                                                                                                                                                                                                                               |
| `MAX_TOTAL_UPLOAD_BYTES` | `1073741824` (1GB)   | 全局磁盘配额，超出返回 **507**                                                                                                                                                                                                                                                   |
| `MAX_ROOM_UPLOAD_BYTES`  | 全局的 1/8（128MB）  | **单房间**配额。文本类作业为主时需调大一档（见 `.env.example` 的计费口径说明）                                                                                                                                                                                                   |

配额、体积、限流、生命周期等调优项（`MAX_FILE_BYTES` / `MAX_TEXT_BYTES` / `MAX_BODY_BYTES` /
`MAX_ROOM_UPLOADS` / `MAX_UPLOAD_NAME_BYTES` / `ROOM_TTL_MS` / `ROOM_MAX_LIFETIME_MS` /
`ROOM_CLEANUP_INTERVAL_MS` / `RELAY_KEEP_ORPHAN_UPLOADS` / `MAX_QUEUE_EVENTS` /
`RATE_LIMIT_*` / `MAX_UPLOAD_BYTES_PER_WINDOW` / `STREAM_TICKET_TTL_MS`）见 `.env.example`。

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

## 3. Docker 部署（推荐）

### 3.1 构建与启动

仓库已提供 `server/Dockerfile` 与 `docker-compose.yml`：

```bash
# 准备环境变量
cp .env.example .env
# 至少填写 RELAY_TOKEN 与 RELAY_ALLOWED_ORIGINS

# 启动（后台）
docker compose up -d --build

# 查看日志
docker compose logs -f relay

# 健康检查
curl http://127.0.0.1:8787/healthz
```

`docker-compose.yml` 已做：

- 容器重启策略 `unless-stopped`
- 上传目录挂命名卷 `relay-uploads`（持久化，容器重建不丢）
- `HEALTHCHECK` 每 30s 探 `/healthz`

### 3.2 仅 Docker（不用 compose）

```bash
docker build -f server/Dockerfile -t coolector-relay .
docker run -d --name coolector-relay \
  -p 8787:8787 \
  -e RELAY_TOKEN=你的强token \
  -e RELAY_ALLOWED_ORIGINS=https://app.example.com \
  -v coolector-uploads:/data/uploads \
  --restart unless-stopped \
  coolector-relay
```

## 4. 反向代理（TLS）

Relay Server 本身不处理 TLS。生产应通过反向代理暴露 HTTPS。

**Relay 不读取 `X-Forwarded-Proto` / `Host` 等请求头来推断自己的对外地址。** 服务端对外**只输出相对路径**，由前端按界面填写（或构建期 `VITE_RELAY_URL`）的 Relay 地址解析。这样做是因为请求头由调用方任意控制，而接收端会自动带凭据去拉取服务端返回的 URL —— 一旦采信这些头，无凭据的发送方只要伪造 `Host`，就能让接收端把管理密钥发往攻击者域（已修复的 F-001）。因此反代侧**不需要**任何特殊配置，HTTPS 下也不存在混合内容问题。

### 4.1 Caddy（自动 TLS，最简）

`deploy/Caddyfile`：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
caddy run --config deploy/Caddyfile
```

Caddy 自动向 Let's Encrypt 申请并续期证书，SSE 默认不缓冲，开箱即用。

### 4.2 Nginx + Let's Encrypt

`deploy/nginx.conf.example`（配合 `certbot --nginx -d relay.example.com`）：

- `proxy_buffering off` 保证 SSE 事件实时下发
- 样例里的 `X-Forwarded-*` / `Host` **仅供代理自身的日志与访问控制**：relay 不读取它们（见上一节），生成绝对 URL 是客户端的事
- `client_max_body_size 20m` 需 >= `MAX_BODY_BYTES`（默认派生 15,160,662 B ≈ 15.16 MB）

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

> 部署模式推荐「子域」：`relay.example.com` 独立反代 relay，`app.example.com` 托管前端。
> 同域 `/relay` 前缀模式需 relay 支持路径前缀，本文档未覆盖，请用子域。

## 6. 安全清单（公网必做）

- [ ] `RELAY_TOKEN` 设为强随机值；前端调用 `/api` 时携带 `Authorization: Bearer <token>`
- [ ] `RELAY_ALLOWED_ORIGINS` 显式设为前端域名（如 `https://app.example.com`）；留空即拒绝所有跨源，`*` 只适合本机/内网
- [ ] 反向代理强制 HTTPS（HSTS 可选）
- [ ] `UPLOAD_DIR` 挂持久卷，并设合理的 `MAX_TOTAL_UPLOAD_BYTES` 防磁盘写满
- [ ] 服务器防火墙只放行 443（反代）与必要的 22；8787 不必对外暴露（由反代转发）

## 7. 持久化与运维

- **上传文件**：存于 `UPLOAD_DIR`，容器请挂卷；房间 `ROOM_TTL_MS` 过期后自动删除并回收配额。
- **房间状态**：存于内存，进程重启即清空（已落盘文件仍在 `UPLOAD_DIR`）。单实例足够；多实例不共享状态（无 Redis/DB），需扩展时请引入外部存储。
- **日志**：stdout/stderr，compose 用 `docker compose logs`，裸跑看终端。
- **升级**：`docker compose up -d --build`（本服务是本地 build + `image: coolector-relay:latest`，**没有远端仓库可 `pull`**，`docker compose pull` 会失败并阻断后续命令）；或重新 `docker build` 后重启。
- **停服**：`docker compose down`（卷保留）；`docker compose down -v` 会删除上传卷。

## 8. 本地开发（不走公网）

```bash
pnpm install
pnpm start          # 同时启动前端(5174) + relay(8787)，前端默认连 127.0.0.1:8787
```

或单独起 relay：`pnpm run relay`。
