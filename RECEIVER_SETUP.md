# 本机当接收端 · 公网发送方 运行手册

目标：**你的电脑作为接收端**，发送方（上传文件的人）在任意外网。
架构：前端（发送端 + 接收端 UI）部署到 GitHub Pages 的**固定地址**；Relay Server 跑在你电脑
（:8787，文件落本机磁盘），用 **ngrok 单条隧道**暴露到公网。发送方通过 Pages 地址上传，文件实时落到你电脑。

```text
发送方(外网) ──> https://<用户名>.github.io/<仓库名>/        ← Pages 前端（固定地址）
                        │  fetch / SSE（跨源、HTTPS）
                        ▼
              https://<随机词>.ngrok-free.dev ──ngrok 隧道──> 你电脑:8787 (Relay)
                                                              ├─> 文件落本机磁盘
                                                              └─> SSE 实时推送
你电脑浏览器 ──> http://localhost:5174 (本机接收端) ───────────────┘
```

> **为什么是这个形态**：ngrok 免费档每个账号只有 **1 个域名** ⇒ 同时只能有 **1 条 HTTP 隧道**；
> 而 Relay 只提供 API、**不托管**前端静态产物。因此「Pages 前端 + 单条 Relay 隧道」是免费档下
> 唯一可行的公网形态。需要「本机前端也暴露到公网」的双隧道形态，见 §8。

## 1. 前置：安装 ngrok 并认证

```bash
scoop install ngrok                           # 或见 https://ngrok.com/download
ngrok config add-authtoken <你的-authtoken>    # Dashboard → Your Authtoken
ngrok config check                            # 应打印 Valid configuration file at …
```

免费档**不需要也不能自选域名**：账号会自动分配 1 个固定开发域名（形如 `<随机词>.ngrok-free.dev`，
跨重启不变），直接 `ngrok http 8787` 即挂在它上面。所以认证只需做一次，以后每次收作业复用同一地址。

> ⚠️ **起 ngrok 前必须清掉代理环境变量**：免费档不允许在 HTTP 代理下运行，否则
> `ngrok http 8787` 会以 `ERR_NGROK_9009` 立即退出。Bash 下写成：
> `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ngrok http 8787`
>
> 其他可选（不在本项目默认路径内）：frp（自建服务端）、Tailscale/ZeroTier（组虚拟局域网，不需公网暴露）。

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

## 3. 一次性配置：把前端发布到 GitHub Pages

每仓库只做一次。做完前端就有了固定地址，之后每次收作业只做 §4。

1. **在 GitHub 仓库配置变量**：仓库 → Settings → Secrets and variables → Actions → **Variables**
   新增 `VITE_RELAY_URL` = `https://<随机词>.ngrok-free.dev`（Relay 的公网地址，**不含尾斜杠**）。
2. **推送触发部署**：`git push`（或手动触发 Actions 的 `Deploy to GitHub Pages`）。
   部署完成后前端固定地址为 `https://<用户名>.github.io/<仓库名>/`。

> ⚠️ **不要**配置任何 `VITE_RELAY_TOKEN` 之类的密钥 Secret。`deploy.yml` 只注入 `VITE_RELAY_URL`，
> 并会跑 `pnpm guard:no-secret` 断言产物里没有密钥。接收端密钥由你在浏览器面板手填、存本机
> `localStorage`，发送方则完全不需要密钥。
>
> 第 1 步没配变量时，工作流会**跳过发布**（线上保持上一版）并在运行摘要里写明原因 ——
> 既不报错，也不会发布一版连不上 Relay 的产物。

**这个变量是构建期内联的**：ngrok 域名一旦变化（换账号等），必须同步改它并重跑部署，否则线上产物
里烤着的是旧域名。查线上产物实际内联了什么：

```bash
curl -s https://<用户名>.github.io/<仓库名>/ \
  | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
```

## 4. 每次收文件时

### 4.1 起 Relay 隧道（一条即可）

```bash
# 免费档：域名自动挂到账号的开发域名上，不需要 --domain
# 必须先清代理，否则 ERR_NGROK_9009（见 §1）
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ngrok http 8787
```

隧道地址取输出的 `Forwarding` 行，或读 <http://127.0.0.1:4040/api/tunnels>，
形如 `https://<随机词>.ngrok-free.dev`。

### 4.2 起本机服务

```bash
pnpm start
# 等价于同时启动：
#   前端  -> http://localhost:5174  (含接收端 RelayReceiver)
#   Relay -> http://localhost:8787  (已通过 --env-file 加载 .env 的 RELAY_TOKEN)
```

> `pnpm start` 会自动用 Node 原生 `--env-file=.env` 把 `RELAY_TOKEN` 注入 Relay 子进程。
> 若你单独跑 Relay：`node --env-file=.env server/relay-server.js`

### 4.3 校对两处域名一致（最易踩的坑）

ngrok 域名出现在**两个**地方，都必须是同一个值：

| 位置                     | 谁读它           | 作用                                 |
| ------------------------ | ---------------- | ------------------------------------ |
| `.env` 的 `VITE_RELAY_URL` | 本机前端         | 本机 `pnpm start` / 本机构建时连接 Relay |
| 仓库 Variables 同名变量    | 公网发送方的前端 | Pages 构建期内联，决定发送方往哪上传     |

不一致的表现是「Pages 能打开、一上传就失败」。改完域名后两处都要动，且 Pages 那处要**重跑部署**。

## 5. 使用

关键顺序：**先由接收端建房，再把房间号发给发送方**。发送方不需要任何密钥，但房间必须已经存在
（不再支持「上传即建房」）。

- **你（接收端）**：浏览器打开 `http://localhost:5174`（或 Pages 地址，同一个页面）→
  1. 「公网接收长连接」面板的 **接收端密钥** 填入 `.env` 里的 `RELAY_TOKEN`（只存本机浏览器）；
  2. **房间 ID 留空**，点「建立长连接」—— 服务端会生成一个完整 UUID 房间号；
  3. 复制页面上显示的房间号，连同 Pages 地址一起发给学生。
  收到的文件会落 `server/uploads/<roomId>/` 并出现在页面。
- **发送方（外网）**：打开 Pages 固定地址 → 选文件 → 在「房间 ID」填你给的房间号 → 点「HTTP 上传到 Relay」。
  他无需填密钥，也不需要登录。
- 双方房间号一致即可点对点收集。房间号就是发送方的唯一凭据，**不要公开张贴**，只说给该交作业的人。

> 房间 ID 至少 8 位；使用 `demo-room`、`test-room` 这类易猜名字时，服务端会写一条
> `weak_room_id` 审计日志。留空让服务端生成 UUID 是最稳妥的做法。

## 6. 安全须知

- [x] `RELAY_TOKEN` 已设置，接收端侧 `/api`（建房/状态/票据/删除）需 Bearer 令牌。
- [x] 令牌**不随前端产物分发**：只存本机 `localStorage`，由 CI 门禁 `pnpm guard:no-secret` 守住。
- [x] SSE 不把长期令牌放进 URL：改用一次性短时效票据（默认 60 秒、用后即焚）。
- [x] 发送方无需密钥，凭不可猜的房间号（默认完整 UUID）上传。
- [x] `.env` 已被 `.gitignore` 忽略，不会提交到仓库。
- [ ] 房间号 = 发送方凭据，**不要公开张贴**；只发给该交作业的人。
- [ ] 公网暴露期间 `RELAY_ALLOWED_ORIGINS` 必须收敛为实际前端来源（见 §7），而非 `*`。
- [ ] 用完即停：关闭 `ngrok` 终端与 `pnpm start`，隧道随即失效，避免长期暴露。
- [ ] 磁盘配额 `MAX_TOTAL_UPLOAD_BYTES`（默认 1GB）限制本机被写满；按需调整。
- [ ] 房间 `ROOM_TTL_MS`（代码常量，默认 6h）到期自动清理；长期任务需改代码调大，或手动删房间。

> **必须收敛 `RELAY_ALLOWED_ORIGINS`**，多个源用逗号分隔 —— Pages 前端与本机前端是**两个不同的源**，
> 都要列上：`RELAY_ALLOWED_ORIGINS=http://localhost:5174,https://<用户名>.github.io`。
> 服务端是**精确匹配**（大小写敏感、不带尾斜杠、不带路径），`Origin` 永远只是
> `https://<用户名>.github.io`，不含 `/coolector/` 这段子路径。写错的表现是「站点能打开、一点就失败」。
>
> **env 只配运维形态**：能写进 `.env` 的只有 9 项（见 `.env.example`）；房间 TTL、条数上限、
> 限流额度等 15 项内部调参是 `server/relay-config.js` 的模块常量 —— 写进 `.env` 不生效，
> 临时覆盖请用 `RELAY_TUNING`（JSON）。

## 7. 排错

| 现象                                  | 原因 / 处理                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 接收端显示「连接失败」                | `VITE_RELAY_URL` 未填或填错；Relay 隧道未起；检查 `.env` 后重启 `pnpm start`                                                    |
| 接收端提示「鉴权失败」                | 面板里填的接收端密钥与 Relay 的 `RELAY_TOKEN` 不一致                                                                            |
| 发送方上传 404                        | 房间不存在或已过期：必须**先由接收端建房**再把房间号发出去；房间 6h 无活动会被回收                                              |
| 发送方上传 401                        | 该请求命中了受保护路由。发送方只应调用 `POST /api/rooms/:roomId/uploads`，不应带管理类请求                                      |
| 发送方上传「房间号至少 8 位」         | 房间 ID 下限已从 4 位提到 8 位（过短易被猜到）                                                                                  |
| 发送方上传被 CORS 拦截                | `RELAY_ALLOWED_ORIGINS` 未包含发送方前端来源（Pages 域）                                                                        |
| 上传大文件报 413                      | 超过 `MAX_FILE_BYTES`（默认 10MB）；请求体上限由它自动派生（不再有 `MAX_BODY_BYTES` 这个 env）                                  |
| 线上产物连不上                        | ngrok 域名变过但仓库变量未同步：改 `VITE_RELAY_URL` 后**重跑 `deploy.yml`**（域名是构建期内联的）                                 |
| ngrok 立即报 `ERR_NGROK_9009`         | 免费档不支持在 HTTP 代理下运行；起隧道前清掉 `HTTP_PROXY`/`HTTPS_PROXY`（见 §1）                                                |
| Web 隧道访问返回 403                  | Vite 默认拦截非 localhost 的 Host 头；已在 `vite.config.ts` 放行 ngrok 域名后缀，换用其他隧道域名需同步加                       |
| 回调地址是 `http://` 导致混合内容被拦 | 接收端界面里填的 Relay 地址应是 `https://…`。服务端只返回相对路径、由前端按该地址解析，因此无需 `RELAY_TRUST_PROXY` 之类的开关  |
| SSE 收不到事件                        | 穿透层缓冲了流；ngrok 实测**不缓冲**（上传→事件约 670ms），若套 Nginx 需关闭 `proxy_buffering`（见 `RELAY_DEPLOY.md` §4）         |

## 8. 附：双隧道形态需要 2 个域名

若想让**本机前端也暴露到公网**（发送方访问你的临时地址、不依赖 Pages），需要同时暴露 `8787` 与
`5174` 两个端口，即 **2 条 HTTP 隧道**。ngrok 免费档只有 1 个域名，**做不到**。此时可选：

- ngrok 付费档 / 自有域名（可挂多条 endpoint）；
- frp（自建服务端）；
- Tailscale / ZeroTier（组虚拟局域网，不需公网暴露）。

该形态下必须额外注意：

- `RELAY_ALLOWED_ORIGINS` 要加上**前端隧道域名**（与 relay 不同源）；
- `vite.config.ts` 的 `allowedHosts` 需放行该隧道域名，否则经隧道访问 dev server 会被 Vite 403 拦截；
- 前端隧道地址每次分享都不同，无法烤进 Pages 产物 —— 也正因如此，本手册默认推荐 §3 的固定形态。

ngrok 免费档限额：1GB/月出流量、2 万请求/月、1 个在线端点，适合小规模文件收集；量大请升级或换自有域名隧道。
