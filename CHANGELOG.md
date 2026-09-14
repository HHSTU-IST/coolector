# Changelog

本项目所有值得记录的变更都会写入本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-09-14

### Security

- **修复「对外 URL 可被请求头劫持」（F-001，Critical）**：此前服务端用 `req.headers.host`
  拼接 `detailsUrl` / `downloadUrl` / `streamUrl` 等对外地址。**无凭据的发送方**只需在上传请求里
  伪造 `Host: evil.example`，接收端就会经 SSE 广播收到 `http://evil.example/...`，
  而接收端前端会**自动带着 `Authorization` 去拉取该地址** —— 全局 `RELAY_TOKEN` 因此被送进
  攻击者服务器。现在服务端**不再从任何请求头推断自身地址**：对外只输出相对路径（如
  `/api/rooms/<id>/uploads/<uid>`），由客户端按自己配置的 Relay 地址解析。
  回归防护：新增「伪造 `Host` 不能进入建房响应 / 上传响应 / 房间快照 / SSE 广播」四条集成断言，
  并附带一条元测试验证「伪造 `Host` 的手段确实生效」（否则用例会退化成空转）。
- **前端加入第二道防线**：`resolveRelayUrl` 对服务端返回的地址做同源校验，非与用户配置的
  Relay 源同源的绝对地址一律拒绝，绝不带着凭据请求。即便服务端被换回旧版本，密钥也不会外泄。
- **`RELAY_TRUST_PROXY` 已移除**：它原先只用于决定是否采信 `x-forwarded-*` 来拼接对外 URL。
  该职责由显式的 `RELAY_PUBLIC_BASE_URL` 取代；HTTPS 反代部署**不再需要任何相关配置**
  （接收端填 `https://…`，相对路径即解析到正确来源，也就不会再有混合内容问题）。
  仍在设置该变量的部署可安全删除 —— 未知变量会被忽略。

### Changed

- **新增 `RELAY_PUBLIC_BASE_URL`（可选）**：对外 URL 的显式基址，也是服务端**唯一**允许产生
  绝对 URL 的来源。留空（默认）= 只输出相对路径，适用于浏览器场景；仅当 curl / 自定义集成等
  非浏览器客户端需要绝对 URL 时才设置。非法值（非 http(s)、含凭据 / 查询串 / hash）会让服务端
  拒绝启动（fail-closed）。
- `.dockerignore` 排除 `server/*.test.js`：测试脚本不再进入生产镜像。
- 请求行解析改用固定基准，不再以 `Host` 头为基准拼 URL。

### Fixed（发布门禁、可用性与合规，第七轮全检）

- **密钥守卫 fail-open**（`guard:no-secret`）：① 体积 >20MB 的产物被静默跳过
  （实测 21MiB 且含密钥仍 exit 0）；② CI 形状下（无 `.env`、无密钥环境变量）整条守卫空转后 exit 0，
  对「真实密钥被内联进产物」**零判别力**。现改为滑动窗口分块扫描（跨块边界同样命中），
  并在「无可核对密钥」时 **exit 1**；CI 与 deploy 的构建/守卫两步都注入同一个**公开 canary**
  （`VITE_RELAY_TOKEN=coolector-canary-<run id>`）—— 一旦有人把构建期读取加回来，canary 就会出现在产物里被拦下
- **CORS 默认放开**：`RELAY_ALLOWED_ORIGINS` 未配置时此前归一为 `*`，而发送方公开写路径本就免凭据，
  等于允许任意站点向已知房间号灌文件。现默认**不发送任何 CORS 头**（拒绝跨源）；
  本机 `pnpm start` 自动注入 localhost 白名单，端到端脚本自带白名单，都不依赖该默认值
- **限流在反代下退化为「全站单桶」**：此前按 socket 地址计数，反代后恒为代理 IP，
  单个滥用者即可让全班 429 且无缓解路径。新增 `RELAY_TRUSTED_PROXIES`（IP/CIDR）：
  只有来自可信代理的请求才按 `X-Forwarded-For` 最左合法值分桶；未声明/直连时**忽略**该头，
  防止伪造 XFF 无限换桶绕过限流。非法条目 fail-closed
- **`VITE_RELAY_URL` 无任何校验**：`//evil.example`（协议相对）会把凭据送去攻击者域，
  无 scheme 的裸域名会被当成页面相对路径而静默打错源。现于模块加载期校验（非法则回落默认值 + 报错），
  手填地址在连接前复用同一套校验；`guard:no-secret` 也校验该变量
- **`RELAY_PUBLIC_BASE_URL` 漏拒尾随 `?` / `#`**：`new URL('…?')` 的 `search` 是空串（falsy）从而绕过检查，
  原样保留的 `…/relay?` 会拼出 `…/relay?/api/x`（路径被吞进 query → 404）。现按**原始输入**判定分隔符，
  且返回值改用规范化后的 `href`（消除「校验的串 ≠ 输出的串」）
- **客户端 256KB 正文截断静默发生**：服务端 `textTruncated` 只反映它自己那 1MB 的截断，
  256KB–1MB 区间收发两端都不提示。信封新增 `textTruncatedByClient`，任一端的截断都会告知接收端
- **`downloadUrl` 只写不读**：该字段全前端无读取点，却会被 `safeResolveRelayUrl` 以「失败保留原值」
  的方式写入 —— 未来一旦给它加下载按钮就会绕过同源校验。现从 store 与落库路径移除
- 收敛 `contentBase64` 的双路径覆盖（`uploadSummary` 原先读的是**从未被赋值**的字段，两个调用方都还得再覆盖一次），
  清理 8 处零引用导出
- **Web Interface Guidelines 合规**：图标按钮补 `aria-label`、表单控件补 `label/for`、
  Toast/连接状态/上传结果补 `aria-live`、`transition-all` 改具体属性、新增 `prefers-reduced-motion` 降级、
  拖放区由 `div` 改为真 `<button>`（可键盘触发）、补 skip link、焦点态改用 `focus-visible`、
  破坏性「清空列表」加确认、标题与加载文案统一用 `…`
- 生产 `sourcemap: false`：`dist/` 会原样发布到公开 Pages，带 `.map` 等于公开全部 TS 源码
- `index.html` 补 `referrer` 策略（URL 里可能带 SSE 一次性票据）；`request_error` 审计日志只记 pathname
- `README` 结构树、`/relay` 子路径说法、nginx `client_max_body_size` 说明（13.4MB → 15.16MB）、
  `docker compose pull`（本服务无远端镜像可拉）等文档漂移一并修正

### Hardened（第七轮收尾：P2/P3 残余项）

- **建房无上限**：房间只在内存里，而建房是持凭据方能持续新增内存对象的入口 —— 一个脚本可以
  一路建房直到进程 OOM。新增 `MAX_ROOMS`（默认 200）：已存在的房间重进不受限，房间随 TTL 回收后自动缓解
- **字节限流只有 IP 维度**：出口 IP 多变的滥用者可集中灌同一个房间。新增按房间的窗口字节额度
  `MAX_ROOM_BYTES_PER_WINDOW`（默认 256MB）—— 单房间被灌爆既不牵连其它房间，也不会瞬间吃掉它的整份配额
- **SSE 票据「先删后校验」会被误烧**：拿 A 房间的票去打 B 房间会把 A 的票作废，接收端随后的合法连接被 401。
  现改为**先校验后删**（过期 / 房间不匹配都不烧票），一次性语义不变
- **Bearer 比较改恒定时间**（`timingSafeEqual`，长度不等直接拒绝），消除理论侧信道
- **信息暴露收敛**：匿名 `GET /` 不再返回 `storageUsedBytes` / `storageLimitBytes`；`/healthz` 只回 `{status}`
  （房间数与 uptime 不再可被匿名收集）。原「无主目录不计配额」的两条集成断言改为**行为断言**
  （新房间仍能上传 + 目录确已被回收），不再依赖匿名路由暴露的数字
- **审计日志不再记录原始文件名**（作业名普遍是「学号+姓名」，即 PII）：改为长度 + SHA-256 摘要，
  仍可用于「同一文件被反复上传」的归并排查
- **`resolveRelayUrl` 加固**：反斜杠归一为正斜杠（`/\evil.example` 这类写法不再能绕过协议相对判定）；
  协议相对地址（`//host`）改走同源检查（原先被静默拼成 `base//host/...` 同源垃圾路径）；
  同源但带 userinfo 的地址剥离凭据（含凭据的 URL 会被 `fetch` 直接拒绝）；补 8 类输入的回归用例
- **e2e 新增显式 origin 断言**：断言所有 `/api` 请求都发往 Relay 源，且建房 / 房间状态 / 票据 / SSE / 正文
  五条解析路径都在真实跨源下走通 —— 解析一旦退化，请求会落到静态站并被 SPA 回退伪装成 200
- **生产构建注入 CSP**（`script-src 'self'`、`object-src 'none'`、`base-uri 'none'` 等；
  `connect-src` 刻意保留任意 http(s)，因为接收端填的 Relay 地址由用户决定）。dev 不注入以免影响 HMR；
  自托管应改放响应头，见 `RELAY_DEPLOY.md` §4.3 新增的响应头清单（HSTS / X-Frame-Options / nosniff / Referrer-Policy）

## [1.0.0] - 2026-09-13

首个正式版本。基于**五轮**上线前全检（代码审查 + 安全审计 + QA 测试）完成安全与质量加固：
第一轮修复 26 项发现；第二轮以独立视角重检并修复 Iteration 1 的 6 项发布阻塞问题；
第三轮修正 2 项未真正修好的声称并补上 3 条阻塞项；第四轮修掉配额层缺陷；
第五轮把**房间生命周期与资源记账**整体重构（统一预占原语 / 目录归属标记 / 错误隔离边界）。

### Security

- **房间目录引入归属标记 + 启动回收收紧到可判定范围**：此前启动时无差别递归删除 `UPLOAD_DIR`
  下**所有**子目录，`UPLOAD_DIR` 一旦指向共享数据根就会删掉无关数据（实测把 `notes.backup/`、
  `my notes/` 一并删光）。现在每个房间目录首次落盘时写入 `.coolector-room`（含 roomId），
  启动回收**只删**「标记存在且标记 roomId == 目录名」的目录；无标记目录不删、不计配额，并在启动日志列出
- **所有的「检查 + 消耗」统一走进原子预占原语**：`reserveStorageQuota` 与 `reserveUploadSlot`
  都在**任何 `await` 之前**同步完成，失败时回滚。历史上这两类资源各自被并发绕过过一次
  （字节 8.39×、条数 10×），根因都是 check-then-act 被 `await` 切断
- **删除失败不得冒泡成进程退出**：`destroyRoom` 的 `rm` 全面 try/catch，清理循环逐房间独立捕获，
  定时任务挂 `.catch`。此前 `rm` 因文件被占用而失败会经未处理拒绝让 relay **exit 1**（整站下线）
- **在途上传感知房间销毁**：`destroyRoom` 先置 `destroyed` 标记，上传落盘后复查，
  已销毁则删掉刚写的文件、回滚配额、返回 **410** —— 此前会返回 201，发送方以为成功而接收端永远收不到
- **落盘后释放内存里的 base64 副本**：`details` 端点改为按需从磁盘读回。此前一份 10MB 上传
  会让 RSS 多出 1.33×（峰值 8.9×），而配额只按解码后大小计
- **配额检查与累加改为原子预占**：原先两者之间隔着 `await persistUpload`，并发可把 4MB 配额打到 8.39×
- **元数据纳入配额并加上限**：`name` / `mimeType` / `lastModified` 此前无长度约束、也不计配额，
  0 字节文件可携带数 MB 元数据以 `storedBytes=0` 通过（实测单条 SSE 帧被放大到 2MB、RSS +58MB）
- **单房间上传条数上限** `MAX_ROOM_UPLOADS`（默认 500），返回 **429** 而非误导性的 507
- **房间绝对存活上限不再豁免接收端**，清理周期可配 `ROOM_CLEANUP_INTERVAL_MS`
- **上传字节限流改为按请求体字节记账**（原先按解码后大小，0 字节上传完全不记账）
- 新增单房间配额 `MAX_ROOM_UPLOAD_BYTES`（默认全局的 1/8）与上传字节限流 `MAX_UPLOAD_BYTES_PER_WINDOW`
- **数值型环境变量改为 fail-closed 校验**：`MAX_FILE_BYTES=10mb` 这类笔误此前会让值为 `NaN`，
  而 `size > NaN` 恒为 false → **体积校验静默全失效**（实测 12MB 文件被照单全收）；现在非法即拒绝启动
- **MIME 类型清洗**：畸形值此前会直通响应头（既可能注入，也让该文件因响应头非法而永久下载 400），
  现统一中和为 `application/octet-stream`，并限制 `type`/`subtype` 各 127 字节
- 下载响应新增 `X-Content-Type-Options: nosniff`
- **前端不再持有接收端管理密钥**：移除 `VITE_RELAY_TOKEN` 的构建期注入与全部读取点
- **发送方走公开写路径**：`POST /api/rooms/:roomId/uploads` 免凭据，房间 ID（默认完整 UUID）即能力凭据；
  同时**移除「上传即建房」** —— 房间必须由接收端先创建，否则 404
- **`?token=` 查询参数彻底移除**：鉴权只接受 `Authorization: Bearer <token>`
- 房间 ID 长度下限由 4 位提高到 8 位；弱房间名会记 `weak_room_id` 审计日志
- Relay 鉴权改为 fail-closed；SSE 改用一次性短时效票据；启动时按磁盘占用初始化配额
- 新增固定窗口请求计数与写入字节双限流；未知内部错误统一模糊为 `Bad request`
- `x-forwarded-proto` / `x-forwarded-host` 仅在 `RELAY_TRUST_PROXY=true`（可信代理后）才采信
- **密钥泄露 CI 守卫** `pnpm guard:no-secret`；根目录新增 `.dockerignore`（此前缺失，
  构建上下文会把含真实密钥的 `.env` 一并送进 daemon）
- （**运维动作**）轮换 `RELAY_TOKEN` —— 旧值曾以内联形式出现在公开产物中，必须视为已泄露

### Fixed

- **房间目录删除失败会让 relay 进程退出**：清理任务由定时器驱动，未处理的 `rm` 拒绝
  会经未处理拒绝把进程带走（实测 exit 1，整站下线）。现 `rm` 全面 try/catch、清理循环逐房间
  独立捕获、定时任务挂 `.catch`；`DELETE` 即使删不掉磁盘也返回 200 并如实标记 `storageRemoved:false`
- **在途上传在房间被删后仍返回 201**（静默丢件：发送方以为成功、接收端永远收不到）：
  `destroyRoom` 先置 `destroyed` 标记，上传落盘后复查，已销毁则删掉刚写的文件、回滚配额、返回 410
- **条数上限并发击穿**：`MAX_ROOM_UPLOADS` 的判断与占用跨 `await`（限额 5、50 并发可全部通过）；
  现走与配额同源的原子预占
- **`limitUploadName` 在上限极小时越界**：为保留扩展名而把 `budget` 钳到 1，
  导致 `MAX_UPLOAD_NAME_BYTES=8` 时输出 17 字节；现扩展名放不下就整段丢弃
- 条数上限的错误码由 507 改为 **429**（507 会被前端解读成「配额已满」，而此时并未满额）
- `details` 端点改为按需从磁盘读回 base64（内存不再常驻副本），契约不变
- `UPLOAD_DIR` 根目录下的散落文件启动时给出告警（既不计配额也不回收）
- 前端 429 文案改为涵盖「上传过于频繁或文件数已达上限」
- 接收端面板新增「存储用量」展示（已用 / 上限，接近上限时标红），使 507 可自诊
- **配额并发击穿**：32 个 1MB 并发上传可让 4MB 配额的房间落盘 8.39×；现改为预占 + 回滚，实测降到 0.79×
- **元数据资源放大**：0 字节文件携带 3MB 文件名时，房间快照会被放大到 3.1MB、单条 SSE 帧到 2MB、
  40 条这类上传可使 relay RSS +58MB 而配额记为 0；现将元数据与文本纳入配额并加上限，快照回落到约 1.1KB
- **超长 `mimeType` 让文件永久不可下载**：≥16KB 的 mimeType 会让下载响应头溢出
  （`UND_ERR_HEADERS_OVERFLOW`）；现超长回落 `application/octet-stream`
- **重启后配额不可逆泄漏**：无主上传目录被永久计入全局配额且无法回收；现启动时回收（带归属判定）
- **`ROOM_MAX_LIFETIME_MS` 被接收端豁免**：持一条 SSE 即可让房间永不过期；现绝对上限不参与豁免
- **集成测试空转**：harness 把 `MAX_UPLOAD_BYTES_PER_WINDOW` 设为 `'0'`（关闭刚新增的字节限流），
  使该逻辑零覆盖；现移除关闭值并补上专门的 429 用例
- 审计日志不再写入完整文件名（改记前 120 字符 + 长度），避免超长名把日志放大到 MB 级
- **`MAX_BODY_BYTES` 漏算信封里的 `text`**：派生上限只算了 base64 膨胀，没算 docx 同时携带的提取正文，
  导致带正文的 docx 有效上限掉到约 8.55MB（名义 10MB）。现派生式为 `base64(4/3) + MAX_TEXT_BYTES + 128KB`
- **`pnpm start` 的 host 回退分支不可达**：`process.loadEnvFile('.env')` 会把文件值写进 `process.env`，
  而 `.env.example` 恰好带 `HOST=0.0.0.0` → 回退分支永远走不到，relay 仍因 fail-closed 整栈退出。
  现未配置令牌时**强制**回环并打印覆盖提示
- **启动失败时退出码恒为 0**：`shutdown()` 的定时器被 `.unref()`，子进程先死后事件循环排空；
  现显式设置 `process.exitCode`
- **Windows 下遗留孤儿进程**：pnpm 经 shell 派生，真正的 vite 是孙进程，`child.kill()` 杀不到它；
  现按进程树结束（`taskkill /T`）
- **0 字节文件被拒**：`contentBase64: ''` 被 falsy 判空 → `400 Missing file content`；现用 `typeof` 判存在
- `readBody` 删掉不可达的 `limit * 4` 强断分支
- 发送方上传成功提示不再展示 `downloadUrl`（该端点需要接收端凭据，发送方打开只会得到 401）
- 前端按状态码给出可读提示（413 文件超限 / 507 配额满 / 429 过于频繁或文件数达上限）
- **中文文件名上传在主路径上直接失败**：发送方曾把文件名放进 `X-Relay-Filename` 请求头，
  而浏览器 `fetch` 只接受 ISO-8859-1 头值，含中文时**请求未出网即抛 `TypeError`**。
  现文件名一律走 JSON 信封 body
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

- **房间生命周期与资源记账整体重构**（不再逐条打补丁）：
  - 所有「检查 + 消耗」统一走原子预占原语（`reserveStorageQuota` / `reserveUploadSlot`），
    从结构上消灭 check-then-act 被 `await` 切断的隐患
  - 所有房间目录带归属标记 `.coolector-room`，删除与回收只认标记
  - 所有删除/清理路径都有错误隔离边界，故障只记录并重试，不冒泡
- 房间目录删除改为可重试语义：`DELETE` 返回 `storageRemoved` 字段，删不掉磁盘也不谎报失败
- 上传落盘成功后内存不再保留 base64 副本；`details` 端点按需从磁盘读回
- 审计日志新增 `room_delete_failed` / `room_expire_failed` / `orphan_file_cleanup_failed`
- `scripts/receiver.mjs` 改为生成随机 UUID 房间号，不再建议 `demo-room`
- 前端新增 `src/utils/relay.ts` 统一凭据存储、地址归一与房间 ID 校验；接收端面板新增「存储用量」
- 上传与下载的体积口径统一：客户端 `MAX_FILE_SIZE` ≡ 服务端 `MAX_FILE_BYTES`
- 构建期依赖（Tailwind / PostCSS / autoprefixer）从 `dependencies` 迁至 `devDependencies`
- 移除未使用的 `@tailwindcss/typography` 依赖；统一 `formatFileSize` / `formatDate` 到 `src/utils/format.ts`
- `docker-compose.yml` 透传 `RELAY_TRUST_PROXY` / `MAX_FILE_BYTES` / `MAX_TEXT_BYTES` /
  `MAX_ROOM_UPLOAD_BYTES` / `MAX_ROOM_UPLOADS` / `MAX_QUEUE_EVENTS` / `MAX_UPLOAD_BYTES_PER_WINDOW` 等
- 文档同步：README、RECEIVER_SETUP、RELAY_DEPLOY、`.env.example` 全部按新鉴权模型与运行期语义重写

### Added

- **Relay HTTP 层集成测试** `server/relay-server.test.js`（31 项，起真实进程打真实 HTTP）：
  覆盖鉴权边界、公开写路径、裸 body 与信封的区分、0 字节文件、413/507/429、
  房间配额隔离、**并发上传不能击穿字节配额与条数上限**、元数据截断与配额计量、
  上传字节限流 429 且不误伤读请求、持 SSE 不能阻止房间绝对上限、
  **启动回收的归属门控（无关目录不被删）**、**删除失败不让进程退出**、
  **在途上传与房间删除的交界不留无人认领文件**、details 端点契约与归属标记。
  此前**路由层长期零覆盖**，而多条发布阻塞缺陷正发生在这里
- **真实浏览器端到端回归** `scripts/e2e-upload.mjs`（`pnpm e2e`，25 项断言，纳入 CI）：
  覆盖中文名 `.md`/`.docx`/`.ipynb`/`.json` 上传、接收端 SSE 收齐与逐字文件名比对、
  二进制占位渲染、8.5MB 大文件、413 可读响应体、404 房间不存在、`?token=` 被拒、
  发送方全程不持有密钥；并断言「浏览器仍禁止非 ISO-8859-1 头值」以防测试空转
- **密钥泄露守卫** `scripts/check-no-secrets.mjs`（`pnpm guard:no-secret`）
- Relay Server 单元测试（`server/relay-utils.test.js`，58 项），并抽离可测试纯函数到 `server/relay-utils.js`
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
