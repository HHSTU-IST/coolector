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

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，容器内/公网用 `0.0.0.0` |
| `RELAY_TOKEN` | 空（关闭） | 设为非空后，所有 `/api` 请求需带 `Authorization: Bearer <token>`。**公网必填** |
| `RELAY_ALLOWED_ORIGINS` | `*` | 逗号分隔的 CORS 白名单；`*` 表示任意。**公网务必收窄**为前端域名 |
| `MAX_BODY_BYTES` | `10485760` (10MB) | 单请求体积上限 |
| `MAX_TOTAL_UPLOAD_BYTES` | `1073741824` (1GB) | 上传目录磁盘配额，超出拒绝新上传 |
| `ROOM_TTL_MS` | `21600000` (6h) | 房间存活时间，过期自动清理并回收磁盘 |
| `MAX_QUEUE_EVENTS` | `200` | 房间离线事件队列上限 |
| `UPLOAD_DIR` | `./server/uploads` | 上传落盘目录，**生产务必挂持久卷** |

所有变量均可选；未设置时走默认值。

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

Relay Server 本身不处理 TLS。生产应通过反向代理暴露 HTTPS，并由代理转发 `X-Forwarded-Proto` / `Host`（relay-server.js 已据此生成正确的绝对 URL 与 SSE 地址）。

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
- `X-Forwarded-Proto $scheme` 让 relay 生成 `https://` 的绝对地址
- `client_max_body_size 20m` 需 >= `MAX_BODY_BYTES`

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
- [ ] `RELAY_ALLOWED_ORIGINS` 收窄为前端域名（如 `https://app.example.com`），不要留 `*`
- [ ] 反向代理强制 HTTPS（HSTS 可选）
- [ ] `UPLOAD_DIR` 挂持久卷，并设合理的 `MAX_TOTAL_UPLOAD_BYTES` 防磁盘写满
- [ ] 服务器防火墙只放行 443（反代）与必要的 22；8787 不必对外暴露（由反代转发）

## 7. 持久化与运维

- **上传文件**：存于 `UPLOAD_DIR`，容器请挂卷；房间 `ROOM_TTL_MS` 过期后自动删除并回收配额。
- **房间状态**：存于内存，进程重启即清空（已落盘文件仍在 `UPLOAD_DIR`）。单实例足够；多实例不共享状态（无 Redis/DB），需扩展时请引入外部存储。
- **日志**：stdout/stderr，compose 用 `docker compose logs`，裸跑看终端。
- **升级**：`docker compose pull && docker compose up -d --build`（或重新 `docker build`）。
- **停服**：`docker compose down`（卷保留）；`docker compose down -v` 会删除上传卷。

## 8. 本地开发（不走公网）

```bash
pnpm install
pnpm start          # 同时启动前端(5174) + relay(8787)，前端默认连 127.0.0.1:8787
```

或单独起 relay：`pnpm run relay`。
