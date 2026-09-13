# Changelog

本项目所有值得记录的变更都会写入本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-13

首个正式版本。基于**两轮**上线前全检（代码审查 + 安全审计 + QA 测试）完成安全与质量加固：
第一轮修复 26 项发现；第二轮以独立视角重检并修复 Iteration 1 的 6 项发布阻塞问题。

### Security

- **前端不再持有接收端管理密钥**：移除 `VITE_RELAY_TOKEN` 的构建期注入与全部读取点。
  该变量会被 Vite 内联进公开的 `dist/` 产物，等于把接收端凭据分发给每个发送方；
  现改由用户在界面填写、仅存本机 `localStorage`，发送方则完全不需要密钥。
- **发送方走公开写路径**：`POST /api/rooms/:roomId/uploads` 免凭据，房间 ID（默认完整 UUID）即能力凭据；
  同时**移除「上传即建房」**——房间必须由接收端先创建，否则 404（原先发送方会落进没有接收端的房间，
  且任何人可用自造 ID 无限建房占用内存与磁盘）
- **`?token=` 查询参数彻底移除**：鉴权只接受 `Authorization: Bearer <token>`。
  原先该兼容分支对**任意** `/api/*` 生效（含 `DELETE`），使一次性票据机制形同虚设
- 房间 ID 长度下限由 4 位提高到 8 位；`demo-room` 等弱房间名会记 `weak_room_id` 审计日志
- Relay 鉴权改为 fail-closed：未设置 `RELAY_TOKEN` 且监听非回环地址时拒绝启动
- SSE 改用一次性短时效票据（`POST /api/rooms/:roomId/stream-ticket`），避免长期 token 进入 URL（日志 / Referer / 浏览器历史）
- 上传落盘目录磁盘配额在启动时按实际磁盘占用初始化，防止进程重启绕过配额
- Relay 增加固定窗口速率限制（默认 60 秒 120 次 / 来源 IP），超限返回 429
- 移除 API 响应中的服务端存储文件名与上传目录绝对路径
- 未知内部错误统一模糊为 `Bad request`，内部细节只写入结构化安全审计日志
- `x-forwarded-proto` / `x-forwarded-host` 仅在 `RELAY_TRUST_PROXY=true`（可信代理后）才采信
- **密钥泄露 CI 守卫** `pnpm guard:no-secret`：构建后断言产物中不含任何密钥值
- （**运维动作**）轮换 `RELAY_TOKEN` —— 旧值曾以内联形式出现在公开产物中，必须视为已泄露

### Fixed

- **中文文件名上传在主路径上直接失败**：发送方曾把文件名放进 `X-Relay-Filename` 请求头，
  而浏览器 `fetch` 只接受 ISO-8859-1 头值，含中文时**请求未出网即抛 `TypeError`**。
  现文件名一律走 JSON 信封 body；`decodeHeaderValue` 只修服务端解码，无法替代客户端编码
- **`.json` / `.ipynb` 上传必失败**：服务端曾仅凭 `Content-Type: application/json` 判定信封，
  而正文本身就是 JSON 的文件会被误判为信封并报 `Missing file content`。
  现改为只在显式 `X-Relay-Envelope: 1` 时解析信封
- **文件体积实际上限只有约 7.86MB**：请求体上限被直接当成文件上限，而 base64 会膨胀 4/3。
  现拆分为 `MAX_FILE_BYTES`（文件，默认 10MB）与由其派生的 `MAX_BODY_BYTES`
- **超限请求只报 `Failed to fetch`**：原先在写响应前就 `req.destroy()`，客户端拿不到错误体。
  现返回带可读信息的 **413**；磁盘配额超限返回 **507**
- **接收端把二进制文件渲染成乱码**：原先对 `contentBase64` 做 `atob` 后直接展示，
  现改为复用二进制占位文案
- `.ipynb` 未被 `isTextMimeType` 识别（浏览器常给不出可靠 MIME），已补扩展名兜底
- Relay 接收端在 SSE 只推送元信息后丢失文件全文与二进制内容（改为按 `detailsUrl` 按需拉取正文）
- 文件名范式 ReDoS 拦截遗漏嵌套可选量词（如 `(a?)*`、`(\w+\s?)*`）
- docx 解压增加 64 MB 膨胀上限，防止压缩炸弹导致内存耗尽
- `docker-compose` 的 `RELAY_ALLOWED_ORIGINS` 空值不再导致 CORS 头缺失
- **新克隆仓库执行 `pnpm start` 两个进程全灭**：编排器把 relay `HOST` 硬编码为 `0.0.0.0`，
  与 fail-closed 检查冲突。现未配置令牌时自动回退 `127.0.0.1` 并给出提示

### Changed

- 前端新增 `src/utils/relay.ts` 统一凭据存储、地址归一与房间 ID 校验；两个组件不再各写一份
- 房间 ID 默认改为完整 `randomUUID()`（128 bit 熵），替代原先 8 位十六进制
- 上传与下载的体积口径统一：客户端 `MAX_FILE_SIZE` ≡ 服务端 `MAX_FILE_BYTES`
- 构建期依赖（Tailwind / PostCSS / autoprefixer）从 `dependencies` 迁至 `devDependencies`
- 移除未使用的 `@tailwindcss/typography` 依赖
- 统一 `formatFileSize` / `formatDate` 实现到 `src/utils/format.ts`
- `scripts/receiver.mjs` 改为生成随机 UUID 房间号，不再建议 `demo-room`
- `docker-compose.yml` 透传 `RELAY_TRUST_PROXY` / `MAX_FILE_BYTES` / `STREAM_TICKET_TTL_MS` / `RATE_LIMIT_*`
- 文档同步：README、RECEIVER_SETUP、RELAY_DEPLOY、`.env.example` 全部按新鉴权模型重写，
  删除「令牌会打进前端产物」的旧说明

### Added

- **真实浏览器端到端回归** `scripts/e2e-upload.mjs`（`pnpm e2e`，25 项断言，纳入 CI）：
  覆盖中文名 `.md`/`.docx`/`.ipynb`/`.json` 上传、接收端 SSE 收齐与逐字文件名比对、
  二进制占位渲染、8.5MB 大文件、413 可读响应体、404 房间不存在、`?token=` 被拒、
  发送方全程不持有密钥；并断言「浏览器仍禁止非 ISO-8859-1 头值」以防测试空转
- **密钥泄露守卫** `scripts/check-no-secrets.mjs`（`pnpm guard:no-secret`）
- Relay Server 单元测试（`server/relay-utils.test.js`），并抽离可测试纯函数到 `server/relay-utils.js`
- 项目版本号与 CHANGELOG

### CI

- CI 增加 `lint` 与单元测试步骤（原先仅 typecheck + build）
- CI 增加 `pnpm guard:no-secret` 与真实浏览器回归（`playwright install chromium` + `node scripts/e2e-upload.mjs`）
- 发布流程改用 `softprops/action-gh-release@v2` 并自动生成 release notes
- GitHub Pages 部署仅在 push 到主分支时触发；`deploy.yml` 不再注入任何密钥 Secret

### 升级注意

- **升级顺序建议「先前端、后 Relay」**：新前端会带 `X-Relay-Envelope` 标志，
  旧 Relay 仍能正确解析该信封；反之旧前端（不带标志）配新 Relay 时，
  正文是 JSON 的文件会被当成裸字节处理。
- 部署 HTTPS 反向代理时**必须**设置 `RELAY_TRUST_PROXY=true`。
