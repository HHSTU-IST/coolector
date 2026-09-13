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

`.env` 已生成（gitignored），含 `RELAY_TOKEN`。
**务必保管好 `RELAY_TOKEN`**：它是接收端管理密钥，泄露等同于任何人可查看、下载、删除你的全部收集。

> 该密钥**只**存在于服务端与你本机的浏览器（填在接收端面板里、存 `localStorage`）。
> 它**不会**被打进前端产物 —— 前端产物是公开的，任何 `VITE_*` 变量都会被访问者读出来。
> 仓库里有一条 CI 门禁 `pnpm guard:no-secret` 专门断言「产物中不含密钥」。

如需自换令牌：

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
# 把输出填到 .env 的 RELAY_TOKEN，然后重启 pnpm start
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

关键顺序：**先由接收端建房，再把房间号发给发送方**。发送方不需要任何密钥，但房间必须已经存在
（不再支持「上传即建房」）。

- **你（接收端）**：浏览器打开 `http://localhost:5174` →
  1. 「公网接收长连接」面板的 **接收端密钥** 填入 `.env` 里的 `RELAY_TOKEN`（只存本机浏览器）；
  2. **房间 ID 留空**，点「建立长连接」—— 服务端会生成一个完整 UUID 房间号；
  3. 复制页面上显示的房间号，连同发送方地址一起发给学生。
  收到的文件会落 `server/uploads/<roomId>/` 并出现在页面。
- **发送方（外网）**：打开你给的地址 → 选文件 → 在「房间 ID」填你给的房间号 → 点「HTTP 上传到 Relay」。
  他无需填密钥，也不需要登录。
- 双方房间号一致即可点对点收集。房间号就是发送方的唯一凭据，**不要公开张贴**，只说给该交作业的人。

> 房间 ID 至少 8 位；使用 `demo-room`、`test-room` 这类易猜名字时，服务端会写一条
> `weak_room_id` 审计日志。留空让服务端生成 UUID 是最稳妥的做法。

## 5. 安全清单

- [x] `RELAY_TOKEN` 已设置，接收端侧 `/api`（建房/状态/票据/删除）需 Bearer 令牌。
- [x] 令牌**不随前端产物分发**：只存本机 `localStorage`，由 CI 门禁 `pnpm guard:no-secret` 守住。
- [x] SSE 不把长期令牌放进 URL：改用一次性短时效票据（默认 60 秒、用后即焚）。
- [x] 发送方无需密钥，凭不可猜的房间号（默认完整 UUID）上传。
- [x] `.env` 已被 `.gitignore` 忽略，不会提交到仓库。
- [ ] 房间号 = 发送方凭据，**不要公开张贴**；只发给该交作业的人。
- [ ] 公网暴露期间 `RELAY_ALLOWED_ORIGINS` 建议收窄为前端实际来源（见 `.env` 注释），而非 `*`。
- [ ] 用完即停：关闭两个 `cloudflared` 终端与 `pnpm start`，隧道随即失效，避免长期暴露。
- [ ] 磁盘配额 `MAX_TOTAL_UPLOAD_BYTES`（默认 1GB）限制本机被写满；按需调整。
- [ ] 房间 `ROOM_TTL_MS`（默认 6h）到期自动清理；长期任务调大或手动删房间。

## 6. 排错

| 现象                        | 原因 / 处理                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 接收端显示「连接失败」      | `VITE_RELAY_URL` 未填或填错；Relay 隧道未起；检查 `.env` 后重启 `pnpm start`                                  |
| 接收端提示「鉴权失败」      | 面板里填的接收端密钥与 Relay 的 `RELAY_TOKEN` 不一致                                                          |
| 发送方上传 404              | 房间不存在或已过期：必须**先由接收端建房**再把房间号发出去；房间 6h 无活动会被回收                            |
| 发送方上传 401              | 该请求命中了受保护路由。发送方只应调用 `POST /api/rooms/:roomId/uploads`，不应带管理类请求                    |
| 发送方上传「房间号至少 8 位」| 房间 ID 下限已从 4 位提到 8 位（过短易被猜到）                                                               |
| 发送方上传被 CORS 拦截      | `RELAY_ALLOWED_ORIGINS` 未包含发送方前端来源                                                                  |
| 上传大文件报 413            | 超过 `MAX_FILE_BYTES`（默认 10MB）；请求体上限由它自动派生，无需手动改 `MAX_BODY_BYTES`                        |
| 隧道 URL 每次都变           | quick tunnel 特性；需要固定域名请用 ngrok / cloudflared 命名隧道 / 自有域名                                   |
| Web 隧道访问返回 403        | Vite 默认拦截非 localhost 的 Host 头；已在 `vite.config.ts` 设 `allowedHosts: ['.trycloudflare.com']`，换用其他隧道域名需同步加 |
| 回调地址是 `http://` 导致混合内容被拦 | 接收端界面里填的 Relay 地址应是 `https://…`。服务端只返回相对路径、由前端按该地址解析，因此无需 `RELAY_TRUST_PROXY` 之类的开关 |
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

2. **在 GitHub 仓库配置变量**：
   - 仓库 → Settings → Secrets and variables → Actions：
     - **Variables** 新增 `VITE_RELAY_URL` = `https://your-name.ngrok-free.app`（Relay 的稳定公网地址，不含尾斜杠）
   - ⚠️ **不要**配置任何 `VITE_RELAY_TOKEN` 之类的密钥 Secret。
     `deploy.yml` 只注入 `VITE_RELAY_URL`，并会跑 `pnpm guard:no-secret` 断言产物里没有密钥。
     接收端密钥由你在浏览器面板手填、存本机 `localStorage`，发送方则完全不需要密钥。

3. **推送触发部署**：`git push`（或手动触发 Actions 的 `Deploy to GitHub Pages`）。
   部署完成后前端固定地址为 `https://<用户名>.github.io/<仓库名>/`。

### 7.2 每次收文件时（日常流程）

4. **起 Relay 固定隧道**（一条即可）：

   ```bash
   ngrok http --domain=your-name.ngrok-free.app 8787
   ```

5. **起本机服务**：`pnpm start`（Relay :8787 + 前端 :5174）。

6. **你（接收端）**：浏览器开 `http://localhost:5174` → 顶部接收端填 `.env` 的 `RELAY_TOKEN`，
   房间 ID **留空** → 连接，拿到服务端生成的 UUID 房间号。

7. **发送方（外网）**：访问固定地址 `https://<用户名>.github.io/<仓库名>/`，填你给的房间号 + 选文件 → 发送。
   他不需要密钥；房间必须已由你先创建，否则会收到 404。

### 7.3 安全须知（务必读）

- **接收端密钥不进前端产物**。`VITE_*` 变量会被 Vite 在构建期内联进 JS bundle，前端一旦公开部署，
  任何人加载页面都能从产物里读出它。因此本项目**刻意不提供** `VITE_RELAY_TOKEN`：
  密钥只由你在浏览器面板填写、存本机 `localStorage`；发送方（学生）完全不需要密钥。
  回归防护由 `pnpm guard:no-secret` 承担 —— 它会在 CI 里断言产物中不含任何密钥值。
- **房间号即发送方凭据**。服务端默认生成完整 UUID；房间号被谁看到，谁就能往该房间传文件。
  不要把它写进公开的公告或群公告。
- **SSE 用一次性票据**。EventSource 无法自定义请求头，我们没有退回「把令牌放 URL」，
  而是由接收端先 `POST /api/rooms/:roomId/stream-ticket` 换一次性短时效票据（默认 60 秒、用后即焚）。
- 建议把 `.env` 里 `RELAY_ALLOWED_ORIGINS` 收窄为 `https://<用户名>.github.io`，至少挡住非浏览器直连的跨域。
- ngrok 免费档限额：1GB/月出流量、2 万请求/月、1 个在线端点，适合小规模文件收集；量大请升级或换自有域名隧道。
