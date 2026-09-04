# 本机当接收端 · 公网发送方 运行手册

目标：**你的电脑作为接收端**，发送方（上传文件的人）在任意外网。
架构：你的电脑同时跑 Relay Server（:8787，存文件落本机磁盘）和前端（:5174，含接收端），
用内网穿透把这两个端口暴露到公网，发送方通过公网地址上传，文件实时落到你电脑。

```text
发送方(外网) ──HTTPS──> 穿透隧道 ──> 你电脑:8787 (Relay) ──SSE──> 你电脑:5174 (接收端)
                                                                          │
                                                                          └─> 文件落本机磁盘 + 浏览器下载
```

## 1. 前置：安装内网穿透（cloudflared，免费、免账号）

本机当前未安装任何穿透工具。任选其一：

```bash
# 方式 A：cloudflared quick tunnel（推荐，免注册，URL 随机每次不同）
#   Windows (winget):
winget install --id Cloudflare.cloudflared
#   或 Scoop:
scoop install cloudflared
#   验证：
cloudflared --version

# 方式 B：ngrok（需注册拿 authtoken，URL 稳定可固定）
#   见 https://ngrok.com/download
```

> 其他可选：frp（自建服务端）、Tailscale/ZeroTier（组虚拟局域网，不需公网暴露）。
> 本文以 cloudflared quick tunnel 为例。

## 2. 准备令牌与配置

`.env` 已生成（gitignored），含 `RELAY_TOKEN` 与 `VITE_RELAY_TOKEN`（一致）。
**务必保管好 `RELAY_TOKEN`**，泄露等同于任何人可向你电脑上传文件。

如需自换令牌：

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
# 把输出同时填到 .env 的 RELAY_TOKEN 与 VITE_RELAY_TOKEN
```

## 3. 启动（关键顺序：先起 Relay 隧道，再起服务）

### 3.1 暴露 Relay（:8787）

新开一个终端：

```bash
cloudflared tunnel --url http://localhost:8787
```

输出类似：

```text
Your quick Tunnel is available at: https://xxxx.trycloudflare.com
```

复制该 `https://xxxx.trycloudflare.com`，它就是 **RELAY_URL**。

### 3.2 把 RELAY_URL 写进 .env 并启动一体服务

编辑 `.env`，把 `VITE_RELAY_URL=` 填成上面的地址，然后：

```bash
pnpm start
# 等价于同时启动：
#   前端  -> http://localhost:5174  (含接收端 RelayReceiver)
#   Relay -> http://localhost:8787  (已通过 --env-file 加载 .env 的 RELAY_TOKEN)
```

> `pnpm start` 会自动用 Node 原生 `--env-file=.env` 把 `RELAY_TOKEN` 注入 Relay 子进程。
> 若你单独跑 Relay：`node --env-file=.env server/relay-server.js`

### 3.3 暴露前端（:5174，给发送方用）

再开一个终端：

```bash
cloudflared tunnel --url http://localhost:5174
# 得到 https://yyyy.trycloudflared.com  —— 这就是「发送方地址」，分享给别人
```

## 4. 使用

- **你（接收端）**：浏览器打开 `http://localhost:5174`，页面顶部「接收端」区填房间 ID（默认 `demo-room`）→ 连接。
  此时你的电脑即接收端，收到的文件会落 `server/uploads/` 并出现在页面。
- **发送方（外网）**：把 `https://yyyy.trycloudflared.com` 发给他。他打开后：
  - 底部「预览/文件查看器」填同样的房间 ID + 选文件 → 发送；
  - 或自己部署的静态前端（见 `RELAY_DEPLOY.md`）填 `VITE_RELAY_URL=<RELAY_URL>` 后访问。
- 双方房间 ID 一致即可点对点收集。

## 5. 安全清单

- [x] `RELAY_TOKEN` 已设置，所有 `/api` 需令牌；SSE 走 `?token=` 查询参数携带。
- [x] `.env` 已被 `.gitignore` 忽略，不会提交到仓库。
- [ ] 公网暴露期间 `RELAY_ALLOWED_ORIGINS` 建议收窄为前端实际来源（见 `.env` 注释），而非 `*`。
- [ ] 用完即停：关闭两个 `cloudflared` 终端与 `pnpm start`，隧道随即失效，避免长期暴露。
- [ ] 磁盘配额 `MAX_TOTAL_UPLOAD_BYTES`（默认 1GB）限制本机被写满；按需调整。
- [ ] 房间 `ROOM_TTL_MS`（默认 6h）到期自动清理；长期任务调大或手动删房间。

## 6. 排错

| 现象                        | 原因 / 处理                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 接收端显示「连接失败」      | `VITE_RELAY_URL` 未填或填错；Relay 隧道未起；检查 `.env` 后重启 `pnpm start`                                  |
| 发送方上传 401 Unauthorized | 前端 `VITE_RELAY_TOKEN` 与 Relay `RELAY_TOKEN` 不一致，或发送方前端未带该变量构建                             |
| 发送方上传被 CORS 拦截      | `RELAY_ALLOWED_ORIGINS` 未包含发送方前端来源                                                                  |
| 隧道 URL 每次都变           | quick tunnel 特性；需要固定域名请用 ngrok / cloudflared 命名隧道 / 自有域名                                   |
| Web 隧道访问返回 403        | Vite 默认拦截非 localhost 的 Host 头；已在 `vite.config.ts` 设 `allowedHosts: ['.trycloudflare.com']`，换用其他隧道域名需同步加 |
| SSE 收不到事件              | 穿透层缓冲了流；cloudflared 默认不缓冲，若套 Nginx 需 `proxy_buffering off`（见 `deploy/nginx.conf.example`） |

## 7. 更稳妥的替代：前端部署到 GitHub Pages（只穿透 Relay 一条隧道）

适合「发送方想要固定网址、不想每次分享随机地址」的场景。
核心变化：前端（发送端+接收端 UI）部署到 GitHub Pages 固定地址，Relay 仍跑你电脑、用**固定域名**隧道暴露。

> ⚠️ **前提：Relay 必须有稳定公网域名**。cloudflared quick tunnel 的 URL 每次重启都变，
> 烤进 Pages 前端后就失效。请改用 **ngrok 免费档的固定静态域名**（每账号 1 个，`your-name.ngrok-free.app`，重启不变）。
> 详见下方第 4 步。

### 7.1 一次性配置（每仓库一次）

1. **领取 ngrok 固定域名**：
   - 注册 ngrok（<https://ngrok.com）→> Dashboard → Domains → New Domain，领取形如 `your-name.ngrok-free.app` 的免费静态域名。
   - 本机认证：`ngrok config add-authtoken <你的authtoken>`

2. **在 GitHub 仓库配置变量/密钥**：
   - 仓库 → Settings → Secrets and variables → Actions：
     - **Variables** 新增 `VITE_RELAY_URL` = `https://your-name.ngrok-free.app`（Relay 的稳定公网地址，不含尾斜杠）
     - **Secrets** 新增 `VITE_RELAY_TOKEN` = 与 `.env` 里 `RELAY_TOKEN` 相同的值
   - `deploy.yml` 的 build 步骤已读取这两个值注入构建产物。

3. **推送触发部署**：`git push`（或手动触发 Actions 的 `Deploy to GitHub Pages`）。
   部署完成后前端固定地址为 `https://<用户名>.github.io/<仓库名>/`。

### 7.2 每次收文件时（日常流程）

4. **起 Relay 固定隧道**（一条即可）：

   ```bash
   ngrok http --domain=your-name.ngrok-free.app 8787
   ```

5. **起本机服务**：`pnpm start`（Relay :8787 + 前端 :5174）。

6. **你（接收端）**：浏览器开 `http://localhost:5174` → 顶部接收端填房间 ID → 连接。

7. **发送方（外网）**：访问固定地址 `https://<用户名>.github.io/<仓库名>/`，底部填同样房间 ID + 选文件 → 发送。

### 7.3 安全须知（务必读）

- **令牌会打进前端产物**：`VITE_*` 是 Vite 构建期内联进 JS bundle 的，前端一旦公开部署，
  任何人加载页面都能从产物里读出 `VITE_RELAY_TOKEN`。因此该令牌**只能视为「防止路人随手乱传」，
  不是强认证**。真正需要强鉴权时，应改用 ngrok 的 OAuth/基础认证或给 Relay 加登录态（超出当前实现）。
- 建议把 `.env` 里 `RELAY_ALLOWED_ORIGINS` 收窄为 `https://<用户名>.github.io`，至少挡住非浏览器直连的跨域。
- ngrok 免费档限额：1GB/月出流量、2 万请求/月、1 个在线端点，适合小规模文件收集；量大请升级或换自有域名隧道。
