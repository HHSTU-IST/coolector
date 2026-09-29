# Changelog

本项目所有值得记录的变更都会写入本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [2.0.0] - 2026-09-29

### Added

- **房间元数据持久化：重启不再丢作业**。每个房间目录内新增 `room.json`（原子写：先写
  `room.json.tmp` 再 `rename`，每房间一条串行链，失败只记日志绝不抛错），保存房间
  `createdAt` / `updatedAt` 与每条上传的元数据。服务启动时据此**重建房间与上传**并
  **逐字节复原**磁盘配额占用。
  - 此前房间只在内存、磁盘目录在启动瞬间一律是「无主目录」，只能**回收**（删掉）——
    重启等于「全班作业消失」。现在同一个目录变成「重启后仍可访问的作业」。
  - 正文（`text`）**不写进元数据**：它是落盘字节的纯函数，而文本类作业的正文可达 1 MB，
    写进去会让每个房间的元数据文件随作业量线性膨胀。`details` 端点改为在正文缺席时
    从磁盘字节**按需推导**（与上传路径共用 `deriveUploadText`，铁律 20），因此重启前后的
    正文口径完全一致。`previewText` / `textTruncated` 是上传那一刻的截断产物、事后无法还原，
    故必须持久化；`quotaBytes` 同理（否则重启后配额会凭空变化）。
  - **启动恢复只读不删**：没有 `room.json`、或元数据损坏 / 与目录名不符的目录一律跳过并告警，
    既不删除也不计入配额。`createdAt` 一并持久化，使绝对存活上限在重启后依然有效，
    不会出现「重启即获得 24 小时免死金牌」。
  - 有意保留的取舍：`destroyRoom` 的 `rm` 失败时（目录残留、元数据还在），下次启动会把该房间
    **恢复出来** —— 作业确实还在、删除本就没成功，恢复比悄悄丢掉更符合「不误删」原则；
    若它已过期，下一轮清理会立即再尝试删除。
  - 门禁有效性已实测（定点突变，每次精确命中）：① 移除上传路径的元数据落盘 → 恰好 2 条变红；
    ② 去掉串行链 → 「任何时刻只有一个写入在跑」用例稳定变红（`expected 5 to be 1`）；
    ③ 去掉 details 的正文推导 → 恰好 1 条变红；④ 去掉恢复时的配额累加 → 恰好 1 条变红。
  - 顺带修正一条**此前因错误理由而通过**的用例：最初的「并发写入」用例里，5 次
    `serializeRoom` 都发生在各自 `await` 之后、读到的都是全量状态，因此去掉串行链仍会通过。
    现改为按 `destroyRoom({ removeDir })` 的既有模式注入一个记录并发度的替身，直接观测串行性。
  - 新增 `PREVIEW_TEXT_CHARS`（`relay-config.js` 的模块常量）：服务端截预览与恢复元数据时
    兜住 `previewText` 上限共用同一个值，不再是两处裸写的 `4096`。
- **客户端新增「全部文件体积之和」上限（128 MB）**。此前前端只拦两件事：单文件 10 MB、文件总数
  200 个 ⇒ 理论上限 **2 GB**，全部常驻前端堆（文本文件的 `content` 是解码后的字符串，中继接收来
  的文件还有 `contentBase64`），足以让标签页直接 OOM —— 200 个 10 MB 文件完全合法地穿过 `MAX_FILES`，
  却要吃掉 2 GB。取值与服务端 `MAX_ROOM_UPLOAD_BYTES` 的默认值（全局 1 GB 的 1/8）一致：本地装得下
  的量本来就传不进一个房间，提前在本地拦下比上传到一半被 507 拒绝更友好。
  - **记账遵循「原子预占」，与 `relay-state.js` 同一模式**：`file.size` 无需读取内容即可得到，因此
    检查与扣减能完整落在 `await file.arrayBuffer()` **之前**，入列失败在 `catch` 中回滚。
    ⚠️ 检查若落在 `await` 之后，并发 `addFile` 会同时读到旧计数而击穿上限 —— 这正是服务端复发过的
    同一缺陷类（4 MB 配额被 32 并发打到 8.39×）。新增用例专门覆盖并发入列：退回「await 后检查」即变红。
  - 中继接收路径（`upsertRelayFile`）参与同一记账以保持口径统一，但**不设硬闸**：单房间体积已由服务端
    配额逐房间约束，再加一道会在接收热路径上引入「可被中断的失败」。重复 upsert 同一 `uploadId`
    按差值调整，不重复累加。
  - 文件列表标题处显示「N 个文件 · 合计 X / 上限 Y」，达到 90% 时数字转琥珀色。
- **`server/` 与 `shared/` 纳入类型检查**（新增 `tsconfig.server.json`：`allowJs` + `checkJs` + `strict`）。
  此前 `vue-tsc -b` 只覆盖 `src/` 与 `vite.config.ts` —— 约 **1 995 行服务端生产代码零编译期保障**，
  只能靠 oxlint（不做类型分析）与测试兜底。
  - 做法由**实测的错误分布**决定，而非预设严格档：`strict` 全开时报 **467** 条，其中 **92%** 是
    `noImplicitAny` / `strictNullChecks` / catch 变量 `unknown` 三个开关的产物，且 **61% 落在测试文件**；
    生产代码只有 136 条，其中 **106 条是「函数参数没写 JSDoc」**。因此本轮把生产代码修到 0 错误，
    测试文件暂缓（理由见该配置内的 `exclude` 注释）。
  - 过程中暴露出 **两处真实缺陷**，而非单纯的标注缺失：① `parsePositiveInt` 的返回类型没写成判别联合，
    使 `value` 被推断为 `number | null` 并一路传染出 **17 条** `possibly null`（全部配置常量受影响）；
    ② `makeCorsHeaders` 的返回值被字面量类型收窄，`Vary` 头的赋值实际处于**未受检**状态。
  - 新增 `requireStoragePath()`：`Upload.storagePath` 在类型上可选，但能走到下载与销毁清理的上传
    必然来自落盘成功 —— 把这层契约显式化，而不是用类型断言掩盖。
  - **门禁有效性已实测**：注入一处类型错误后 `vue-tsc -b` 以退出码 2 失败并精确指向该行。
  - CI 无需改动：`ci.yml` 本就在跑 `pnpm exec vue-tsc -b`，项目引用生效后自动覆盖服务端。
- **docx 正文提取移到服务端，内置前端彻底告别 JSON 信封**。新增 `server/relay-docx.js`
  （ZIP 中央目录解析 + `zlib.inflateRawSync`，零新依赖），`server/relay-utils.js` 新增
  `deriveUploadText(bytes, mimeType, name)` 作为「字节 → 可读正文」的**唯一**实现 ——
  上传路径与 `detailsUrl` 共用它，两处各写一份必然漂移。
  - 此前 docx 必须走 JSON 信封，理由是「客户端提取的正文没有位置放」（裸 body 里只有文件字节），
    代价是整份文件 base64 膨胀 33%、浏览器多一次解压与编码。现在 docx 与普通文件走**同一条**
    裸 body 路径，服务端从刚收到的字节里解压提取，**原始包字节原样落盘**。
  - 前端删除 `src/utils/docx.ts`（187 行）及其测试：同一份提取逻辑不该存在两处（铁律 20），
    何况它让每个发送方都去解别人的文档。
  - 「中继接收来的文件」这条理由也一并消除：上传前在本地做一次 base64 → Blob 转换
    （`base64ToBlob`，**懒**转换 —— 只有真要转发时才付代价）。于是 `X-Relay-Envelope` 不再是
    内置前端任何路径的一部分；服务端**仍然保留**信封解析以兼容第三方/自定义客户端。
  - `src/utils/relay-upload.ts` 从 133 行收敛到 88 行：`truncateEnvelopeText`、
    `arrayBufferToBase64`、`blobToBase64`、`ENVELOPE_TEXT_MAX_BYTES` 随信封一起删除；
    「既无 blob 也无 base64」由「交给服务端报 400」改为**本地抛错**（没有信封可发，
    静默发一个 0 字节请求会让接收端收到空文件）。
  - ⚠️ **发送方界面的行为变化**：本地预览 docx 时不再显示提取正文，改为与其他二进制格式一致的
    占位文案（接收端不受影响，它拿到的仍是服务端提取的正文）。这是「一份实现」的代价。
  - 顺带修掉一处移植来的缺陷：`safeCodePoint` 的区间判定没排除**代理项区间**（U+D800–U+DFFF）——
    该区间不抛错，却会产出孤立代理项、让整段正文变成 ill-formed UTF-16。
  - 验证：`server/relay-docx.test.js` 16 条 + `deriveUploadText` 5 条 + 集成 1 条（裸 body 上传
    docx → details 拿到正文 → 下载端点逐字节等于原件）+ e2e 新增 2 条（接收端渲染出服务端提取的
    正文、docx 原件保真）。夹具 `scripts/lib/docx-fixture.mjs` 手工拼装最小 ZIP，三处测试共用。
- **隧道层探针入库，公网链路验证从此可复跑**。三条经**真实 HTTPS 隧道**的探针移入
  `scripts/probes/`（此前只存在于 gitignore 的临时目录，换会话即丢，等于每次都要重搭台子）：
  `pnpm probe:chain`（建房 → 无凭据上传 → 快照 → 下载逐字节比对 → 一次性票据 → 清理，11 项）、
  `pnpm probe:sse`（SSE 是否被隧道缓冲：首字节到达时间 + 「上传 → 事件」实际延迟，8 项）、
  `pnpm probe:xff`（限流分桶：伪造 `X-Forwarded-For` 能否换桶）。
  - 隧道地址**自动解析**：`PROBE_BASE` → `VITE_RELAY_URL`（经 `--env-file`）→ ngrok 本地 API `:4040`。
    不必再把域名手工抄进环境变量 —— 抄域名正是「改了域名忘了同步」这类故障的温床。
  - 另配 `tunnel-xff-header-probe.mjs` + `echo-upstream.mjs` 做**头级取证**（隧道写下的原始头），
    不依赖 relay 回显。换隧道工具后重跑这三条即可复核，无需重读本仓任何结论。
- **`scripts/check-relay-url.mjs`**：构建期门禁改为调用 `shared/relay-base-url.js`（见 Fixed）。
- **隧道形态的限流分桶已实测定型**（此前只有推理 + 第三方文档），三组证据：
  ① 头级 —— ngrok **追加** `X-Forwarded-For`（客户端伪造值留在左侧，ngrok 注入的真实客户端 IP
  在最右端）；② 行为级 —— 桶打满后换伪造值仍是 `429`（含把伪值设成可信网段内地址）；
  ③ 双出口 —— 换代理出口（另一个公网 IP）后同一个桶仍有空位 ⇒ 是**按客户端地址分桶**，
  而非「全站单桶」。⇒ `.env` 里的 `RELAY_TRUSTED_PROXIES=127.0.0.1/32` 是正确且必要的一条声明。
- 探针新增一条**可复用的判别式**：用「不存在的房间号」打目标（限流先于房间查找，
  故「桶有空位」表现为 `404`、「桶已满」表现为 `429`），既判别分桶形态、又不留任何磁盘垃圾。

### Fixed

- **裸 body 上传的中文文件名被静默存成百分号串**：`X-Relay-Filename` 只做 latin1 还原、
  不解码百分号，于是 `%E4%BD%9C%E4%B8%9A.docx` 原样落库，接收端看到乱码名字，
  下载时 `contentDisposition` 再把它二次编码（`%` → `%25`），老师拿到的是一个打不开的文件名。
  现该头在「解出来确实含非 ASCII 字符」时按百分号解码；纯 ASCII 的 `%XX`（`note%20f.md`）
  **原样保留** —— 那本来就是一个合法文件名，自动解码等于把它悄悄改掉。
- **`?name=` 改为优先于 `X-Relay-Filename`**。查询串是唯一无歧义的通道（`URLSearchParams`
  已完成百分号解码，浏览器也构造得出），且这条顺序给出一个必要出口：文件名里本就含 `%XX` 时，
  `?name=note%2520f.md` 可以精确表达，而头通道表达不了。
- **补上一条空转断言**：`relay-server.test.js` 的裸 body 用例此前只断言 `201` 与 `size`，
  **从不回读文件名** —— 上述缺陷因此活过六轮审计。现改为断言落库文件名、房间快照里的名字
  与下载头的单次编码形态，并覆盖两条通道（`?name=` / 请求头，含 latin1 直传）。
- **限流分桶可被伪造 `X-Forwarded-For` 绕过**（`server/relay-utils.js` 的 `makeClientIpResolver`）：
  反代部署声明 `RELAY_TRUSTED_PROXIES` 后，relay 取的是 XFF 里**最左**那个合法 IP —— 而多跳代理的
  「追加」语义（nginx 的 `$proxy_add_x_forwarded_for`）恰好把客户端自己伪造的那一段留在最左，
  于是换一个伪造值就换一个限流桶，单人即可绕过全站限流。现改为**自最右端向左逐跳回退、跳过仍属
  可信网段的跳、取第一个不可信地址**：最右段由链上可信代理写入（写的是它的直接对端），停下的位置
  即「已被可信代理见证过的真实来源」。三臂同机实测（同 relay 配置，客户端源地址刻意避让可信网段，
  否则同处回环的实验台观测不到差异）：追加式修复前 `201×5`、修复后 `201,201,201,429,429`；
  「完全不写该指令」（原样透传）仍可绕过 —— 那种形态整条头都由客户端控制，服务端无从分辨，
  只能由反代侧修（见 `RELAY_DEPLOY.md` §4.1）。**前提**：`RELAY_TRUSTED_PROXIES` 只能填代理自身
  网段，把客户端地址段也写进去会让真实客户端被当作可信跳跳过。
- 新增两条判别性用例（追加式伪造换桶、XFF 全为可信跳/非法段时回退 socket），并复核旧用例名
  与实现不符之处 —— 已定点突变为「取最左」验证它们确实会红（否则属「因错误理由通过」）。
- **补测两条此前只有推理、没有实测的退化路径**（口径见 `RELAY_DEPLOY.md` §4.1）：
  - `RELAY_TRUSTED_PROXIES` **误含客户端网段**。把客户端所在的 `127.0.0.0/8` 一并声明后，真实客户端
    被当作可信跳跳过，桶键一路退回到最左的伪造值：同一探针下换 XFF 五发全 `201`（**可绕过**），
    而正确声明（仅 `127.0.0.1`）时第 4 发即 `429`。同一个 NAT 出口、同一个 K8s 节点都会撞上这个形态。
  - **双层代理拓扑**（CDN / 云负载均衡 → 本站边缘）。边缘层用覆盖式 `$remote_addr` 时写进去的是
    **外层的 IP**，真实客户端信息整条消失：换 XFF 无效（看起来与正确配置一样），但另两组
    （**同一个伪造值、仅源地址不同**）全部 `429` —— 即所有人落进**同一个桶**，单个滥用者足以让全班
    429；边缘层改用追加式则三组均正确分桶。⇒ 覆盖式只在**单层**拓扑下成立。
  - 两条都以「同 XFF、异源地址」的对照组判别：纯看「换 XFF 能否换桶」时，「全站单桶」与
    「正确按客户端分桶」表现**完全一致**，该指标不足以证明分桶正确。头级回显同时取证：
    追加式 relay 收到 `9.9.9.9, 127.0.0.2, 127.0.0.1`，覆盖式只收到 `127.0.0.1`。
- **再补测三条此前只有推理的路径**（Caddy 双层 / CDN 专用头 / 三层链 + 多段可信声明）。
  6 条臂一次跑完、**零失败**，其中一条**修正了上一轮刚写进文档的口径**：
  - **Caddy 双层**：两层都用默认（`trusted_proxies` 为空）时，内层把外层已经写下的真实客户端
    **覆盖成自己的地址**，链上只剩 `127.0.0.1` ⇒ 所有人落进同一个桶，与 nginx 覆盖式同病。
    在**内层**声明 `servers { trusted_proxies static <外层网段> }` 后它转为追加，实测恢复按客户端
    分桶。⚠️ 该指令在 Caddy 2.11 里**不能**写在 Caddyfile 顶层 —— 会直接报
    `unrecognized global option: trusted_proxies`，必须在 `servers { }` 子块内。
  - **CDN 专用头（`CF-Connecting-IP`）**：边缘层**覆盖**为该头的值时，双层下同样能正确分桶 ——
    即上一轮「双层只能用追加式」应**收窄为「不能覆盖为 `$remote_addr`」**（那写的是上一层的
    地址，与客户端无关）。同时证明「外层必须**覆盖**该头」是**承重**条件：换成透传的定点突变臂
    下，客户端伪造的 `CF-Connecting-IP: 8.8.8.8` 直达 relay 并成为桶键（`201×5` 可绕过）。
  - **三层链 + 多段 `RELAY_TRUSTED_PROXIES`**：链上每一跳都声明时，解析器连续跳过三个互不相同的
    可信跳、停在真实客户端；只声明 relay 的**直接对端**则停在最内层见证的那一跳 ⇒ 全站单桶。
    ⇒ 新增一条部署要求：**声明范围必须覆盖链上每一跳**（含直接对端 —— 解析器先判 socket 对端
    是否可信，不可信时根本不看 XFF）。
  - 三条共用同一套三态判据。两个退化臂在「换伪造值能否换桶」这一指标上与正确配置**逐位相同**，
    只有「同一伪造值、不同源地址」的对照组能区分 —— 与上一条的判别方法论一致。
- **构建期门禁比运行期判据更宽**（`deploy.yml` 的 `Validate VITE_RELAY_URL`）。该步骤是 shell
  `case` 前缀匹配，因语言不通无法 import 共享模块，成了全仓**唯一**需要人肉同步的判据副本，
  且比共享判据更宽：`https://r.example.com?x=1`、`…/#a`、`…user:pass@…` 三类值都能过门禁，
  却被运行期判非法并回落到 `127.0.0.1` ⇒ 表现为「流水线绿、发布成功、但站点谁也连不上」。
  现改为 `node scripts/check-relay-url.mjs` 调用共享实现，副本删除（铁律 20 的那处例外消失）。
  实测 11 组值：合法 https / 同域子路径 / 本机 http / 尾斜杠归一 ⇒ 通过；
  带查询串 / 锚点 / 凭据 / 协议相对 `//evil.example` / 裸域名 / 空值 ⇒ 一律 exit 1。
- **`.env` 注释残留**：`RELAY_TRUSTED_PROXIES` 段仍在说「本机穿透（cloudflared）」，
  而 cloudflared 已于 2026-09-28 从仓库移除；`VITE_RELAY_URL` 段仍写
  `ngrok http --domain=<你的静态域名>` 的旧写法（免费档不能自选域名）。两处均已按现状重写，
  并把上面那三组取证结论写进注释。

### Changed

- ⚠️ **破坏性配置变更：15 项内部调参不再读环境变量，env 只剩 9 项运维变量**。可配置项收敛为
  `PORT` / `HOST` / `UPLOAD_DIR` / `RELAY_TOKEN` / `RELAY_ALLOWED_ORIGINS` /
  `RELAY_PUBLIC_BASE_URL` / `RELAY_TRUSTED_PROXIES` / `MAX_FILE_BYTES` / `MAX_TOTAL_UPLOAD_BYTES`
  —— 每一项都对应「因部署环境而异的形态」。其余 15 项（房间 TTL / 绝对存活上限 / 清理周期 /
  条数上限 / 事件队列 / 房间数上限 / 文件名长度 / 正文上限 / 请求体上限 / 单房间配额 /
  限流窗口与额度 / SSE 票据有效期）在 `relay-config.js` 里落为 `TUNING_DEFAULTS` 模块常量。
  - 划分依据是**旋钮之间的耦合**，不是「重要程度」：`MAX_BODY_BYTES` 由 `MAX_FILE_BYTES` +
    `MAX_TEXT_BYTES` 派生、`MAX_ROOM_UPLOAD_BYTES` 默认取全局配额的 1/8、`ROOM_TTL_MS` 与
    `ROOM_CLEANUP_INTERVAL_MS` 必须协调。逐个暴露只会制造「改了一个、另一个没跟上」的错配 ——
    实测过一次：只调大 `MAX_FILE_BYTES` 而没重算派生上限，带提取正文的 docx 有效上限掉到约 8.55 MB。
  - **升级须知**：`.env` 里若还留着旧旋钮（`ROOM_TTL_MS=` / `MAX_ROOMS=` / `RATE_LIMIT_MAX=` …），
    它们会被**静默忽略**，不会报错、也不会生效。需要这些值就必须改代码，或走下面的覆盖通道。
  - 新增 `RELAY_TUNING`（JSON 对象）作为**唯一**的显式覆盖通道（测试用，也留给确知自己在做什么的
    高级用户）：`RELAY_TUNING={"MAX_ROOMS":10,"RATE_LIMIT_MAX":9999}`。**未知键与非法值一律拒绝
    启动** —— 静默忽略未知键最危险：运维会以为改动生效了，实际跑的还是默认值，然后照着错误的旋钮
    排查问题。错误信息会列出全部可用键。两个窗口额度（`MAX_UPLOAD_BYTES_PER_WINDOW` /
    `MAX_ROOM_BYTES_PER_WINDOW`）允许取 `0`（= 关闭），其余要求 ≥ 1。
  - 派生关系成为一等公民：`MAX_BODY_BYTES = ceil(MAX_FILE_BYTES × 4/3) + MAX_TEXT_BYTES + 128 KB`、
    `MAX_ROOM_UPLOAD_BYTES = max(floor(MAX_TOTAL_UPLOAD_BYTES / 8), 8 MB)`；覆盖派生项等于绕开推导。
  - 顺带把 `MAX_TEXT_BYTES` 的 256 KB 下限从注释变成代码（`Math.max`）：低于它时「10 MB 文件 +
    每次必发的 256 KB 正文」会被自己派生的请求体上限误判 413。
  - 新增 `server/relay-config.test.js`（9 条）直测分层契约：运维变量仍读同名 env、**降级键写成普通
    env 完全不生效**、`RELAY_TUNING` 里的同名键才生效、派生的耦合（调大 `MAX_TEXT_BYTES` 时
    `MAX_BODY_BYTES` 增量精确等于 3 MB；256 KB 下限；单房间配额随全局取 1/8 但有覆盖口子）。
    集成夹具 `startRelay` 改为把扁平 env 自动拆成「运维变量 + `RELAY_TUNING`」，故既有用例写法不变；
    拆分名单漏项是 fail-closed 的（会因「RELAY_TUNING 含未知键」拒绝启动，测试立刻超时而非静默通过）。
  - 门禁有效性已实测（定点突变，每次精确命中）：① 把 `MAX_ROOMS` 改回读 env → 恰好 2 条变红；
    ② 未知名单由 fail-closed 降级为静默忽略 → 恰好 1 条变红（子进程不再退出，用例超时）；
    ③ 派生式退回「只算 base64 膨胀」的历史缺陷 → 恰好 2 条变红（13,981,014 vs 15,160,662）。
  - `.env.example` 从 152 行收到 129 行：只列 9 项运维变量 + `RELAY_TUNING` + 前端构建期变量，
    文件头说明两层划分与「为什么不把这些暴露成 env」。
- **201 响应不再回吐正文，与 SSE 广播的口径统一为「只回元信息」**。此前上传成功后，201 里带着
  整个文件的 base64（原注释写的是「发送方自检用」），而发送方**刚把这些字节发上来** ——
  回显只是让它再下载一遍。实测一次 10 MB 上传：

  |                        | 改前     | 改后         |
  | ---------------------- | -------- | ------------ |
  | 201 响应体             | 13.98 MB | **706 字节** |
  | 往返合计               | 24.47 MB | **10.49 MB** |
  | 耗时中位数（5 次）     | 191.8 ms | **62.0 ms**  |
  | 服务端单次上传峰值内存 | 43.4 MB  | **10.1 MB**  |

  峰值内存那一栏的构成是三份与文件等大的缓冲：`readBody` 的 Buffer 被 `toString('base64')` 编成
  13.33 MB 字符串 → 调用方为读一个 `.length` 解回 Buffer → `persistUpload` 再解一遍。
  现在裸 body 通道**全程不做 base64**（既不解码也不编码）。全仓把整份上传字节编成 base64 的地方
  只剩两处，且都不在这条通道上：details 端点（接收端按需拉正文，须 Bearer 凭据）与信封的
  legacy 兼容分支（客户端只给 `text`/`content` 而未给 `contentBase64` 时）。
  - **文本类文件还有第二层**：摘要的 `contentText` 最多 1 MB，于是一份 8.5 MB 的 `.md` 在 base64
    那层修好后**仍**换回 1.05 MB 的响应。这一层是 e2e 发现的（集成用例只跑了二进制文件）。
    现在 201 与广播一样传 `includeContent: false`，正文一律从 details 端点按需取。
  - ⚠️ **这是一处破坏性变更**：若另有客户端依赖 201 里的 `contentBase64` 或 `contentText`，
    升级前请确认 —— 发送方本就持有原文件，需要正文的一方只有接收端。
- **`persistUpload` 改为接收解码后的 `Buffer`**（此前收 base64 字符串、内部再解一遍）。传入非 Buffer
  会 fail-fast 抛 `TypeError` —— 旧签名下照旧传 base64 会静默写出一份「看起来正常」的坏文件。
- **发送方上传默认改走「裸 body」通道，不再把文件包成 base64 JSON 信封**。前端此前对**所有**文件
  都做 `arrayBufferToBase64` + `JSON.stringify` 再上传，代价是：10MB 文件在客户端主线程阻塞约
  **0.2 s**（本轮实测 232.2 ms = base64 201.1 + 序列化 26.3）、请求体膨胀 **+33.3%**、服务端摄取
  劣化 **2.40×** —— 端到端约 **5.6×** 的差距。这些代价原本只为绕开「HTTP 头只能 ISO-8859-1」，
  而裸 body 通道早就支持 `?name=<百分号编码>`，只是前端没用它。
  现在文件原始字节直接作为请求体（`File` 句柄不再预先编码），文件名走 `?name=`，
  MIME 与修改时间走 `X-Relay-Mime-Type` / `X-Relay-Last-Modified`。
  - 传输形态的选择与请求构造抽出为 `src/utils/relay-upload.ts`（纯函数，19 条用例直接断言请求形状）。
  - **信封仅保留两处例外**：① docx —— 客户端提取的正文没有裸 body 的位置可放，只能随信封一起走；
    ② 中继接收来的文件本地没有原始字节，只剩 base64。两处之外一律走裸 body。
  - 旧版 Relay **无需同步升级**：`?name=` 由 `URLSearchParams` 解码，旧实现在这条通道上本来就是对的
    （上一轮修的是 `X-Relay-Filename` 头通道）。
  - 顺带的语义修正：上传字节限流此前按 base64 后的请求体计费，10MB 文件要占掉 13.33MB 额度；
    现在按真实文件字节计费。
  - **审计日志 `upload_created` 新增 `bodyBytes`**（请求体实际传输字节数），与既有的 `size`
    （解码后字节数）并排记录 ⇒ 线上「是否还有 base64 膨胀」从此可观测，不必靠推断。
    ⚠️ 解析该日志的运维脚本需容忍新字段。
  - **端到端回归补 15 条传输形态断言**：此前 e2e 只断言 `201` 与文件名，**两种传输形态都能满足**
    ⇒ 对形态是盲的（与上一轮文件名缺陷同类的空转问题）。现断言每个上传都不带 `X-Relay-Envelope`、
    `?name=` 逐字还原且已百分号编码、请求体字节数等于文件字节数。
    退回旧行为跑一次即可看到恰好这 15 条变红，原有 27 条不受影响。
- **`VITE_RELAY_URL` 的判据收敛为「http(s) 绝对地址」唯一形态**。同一个值此前有三个判据：
  CI 门禁（`deploy.yml` 的 `Validate VITE_RELAY_URL`）与构建守卫（`check-no-secrets.mjs`）只认
  绝对地址，而前端 `validateRelayUrl` 还放行同源相对路径 `/relay` —— 于是同一个值「本地构建得过、
  CI 拒绝发布」。现三处口径一致（改任一处须同时改另两处）：
  - 前端不再接受 `/relay`：`DEFAULT_RELAY_URL` 遇到该值报错并回落到 `http://127.0.0.1:8787`，
    修正文案后重新构建即可；接收端界面的地址输入框本就是 `type="url"`，浏览器原生也拒绝相对路径。
  - 移除 `vite.config.ts` 里为它配套的 `/relay` dev 代理。本机开发不需要它 —— `pnpm start`
    会自动放行 `http://localhost:5174` 与 `http://127.0.0.1:5174`（见 `server/start.js`），
    前端直填 `http://127.0.0.1:8787` 即可，不必靠代理绕 CORS。
  - **同域挂子路径的部署形态不受影响**，只是地址要写成绝对形式
    （`VITE_RELAY_URL=https://app.example.com/relay`，反代把 `/relay/*` 重写到 relay 根路径）。
- **`VITE_RELAY_URL` 与 `RELAY_PUBLIC_BASE_URL` 的判据合并为一份实现**：新增
  `shared/relay-base-url.js`（纯 ESM、零依赖，浏览器与 Node 共用）。这两个值语义相同
  （都是「relay 的对外基址」），此前却各有一份判据 —— 服务端用 `new URL` 解析并拒绝查询串，
  前端用正则匹配并**静默剥掉**查询串，于是同一个地址可能「前端放行、服务端拒绝启动」或反之。
  现在判定只有一处，`server/relay-utils.js` 与 `src/utils/relay.ts` 都退化为薄包装，
  各自只保留措辞映射；守卫脚本 `scripts/check-no-secrets.mjs` 同步接入。
  - 连带的语义收紧：`normalizeRelayUrl` 不再把非法值悄悄改写成合法值，非法一律返回空串，
    调用方必须**先校验、再归一**（`useRelayReceiver.ts` 已按此调整顺序）。
  - 顺带修掉一个真实缺口：发送方界面（`FileViewer.vue`）此前**只归一、不校验**，
    写错的地址会被原样拼进请求 URL，打到静态站自己身上，表现为「上传成功」却谁也收不到。
  - CI 门禁 `deploy.yml` 的 shell `case` 块因语言不同无法复用该模块，是唯一的人肉同步点
    （已在两处注释里互相指名）。
- **内网穿透的落地形态收敛为 ngrok 单一工具**，文档不再把 cloudflared 列为备选：`RECEIVER_SETUP.md`
  重写为「Pages 前端 + 单条 Relay 隧道」一条路径。这不是偏好问题而是**免费档的硬约束** ——
  ngrok 免费档每账号只有 1 个域名（同时只能 1 条 HTTP 隧道），而 Relay 只提供 API、不托管前端
  静态产物 ⇒ 双隧道形态（本机前端也暴露到公网）在免费档下结构上不成立，已移到文档 §8 并注明
  需 2 个域名（付费档 / 自有域名 / frp / Tailscale）。连带改动：`vite.config.ts` 的 `allowedHosts`
  由 `.trycloudflare.com` 改为 ngrok 的域名后缀；`.env.example` 中「前端页面来自穿透域名」的
  说法改为 Pages 域。
  - 排错表补两条实测结论：① `ERR_NGROK_9009` —— 免费档不允许在 HTTP 代理下运行，起隧道前须清
    `HTTP_PROXY` / `HTTPS_PROXY`；② 「域名变更后线上产物连不上」—— 域名是**构建期内联**的，
    须同步仓库变量并重跑 `deploy.yml`。
  - ngrok 免费档的浏览器 interstitial 警告页只注入 HTML 导航流量，程序化访问（`fetch` /
    `EventSource`）不受影响，故前端与 SSE 均无需附加跳过头。
- **修正 `RELAY_DEPLOY.md` 中关于转发头的自相矛盾，并补上两种反代的实测写法**。原文 §4 有一句
  「`X-Forwarded-*` / `Host` 只对代理自身的日志与访问控制有意义：relay 不读取它们」，而 §2 同一页
  又写「`RELAY_TRUSTED_PROXIES` 留空 = 不采信 `X-Forwarded-For`」（隐含非空即采信）—— 实测确认
  relay **确实读取 XFF**（仅用于限流分桶）。现按两类头分开陈述：`Host` / `X-Forwarded-Proto` /
  `X-Forwarded-Host` 永不读取（F-001）；`X-Forwarded-For` 仅在声明可信代理且请求来自该网段时读取，
  **只用于限流分桶**，不参与 URL 生成。
  - 新增 §4.1「两种代理的实测写法」（原「建议的响应头」顺延为 §4.2）：逐项给出 nginx 1.31.6 与
    Caddy 2.11.4 的实测口径。要点：要求②（关缓冲）在 nginx 下**近乎自动成立** —— 应用侧的
    `X-Accel-Buffering: no` 会被 nginx 消费，故 `proxy_buffering off` 属纵深防御而非必需；
    要求③（请求体上限）在 nginx 下**必须显式写**（默认仅 `1m`，2MB 作业即被 413 截断），
    在 Caddy 下**默认不限制**。
  - 新增 XFF 写法专节，按**拓扑**分**三张表**：单层（追加 / 覆盖 / Caddy 默认 / 完全不写）、
    双层（CDN / 云 LB → 本站边缘：边缘层追加 / 覆盖 / 覆盖为专用头值 / 外层透传专用头 /
    Caddy 默认 / Caddy 内层声明 `trusted_proxies`）与三层（多段可信声明：每跳都声明 /
    只声明直接对端）。**修复 relay 取值端之后，单层只剩「完全不写」仍可绕过** —— 它让整条 XFF
    都由客户端控制；多跳下的三种失效形态（覆盖为 `$remote_addr`、Caddy 默认、只声明直接对端）
    都会退化成全站单桶 ⇒ 文档口径由「追加或覆盖都安全」收窄为**「取决于拓扑」**：覆盖率只在单层
    无条件成立；多跳时要么每层追加**且把链上每一跳都写进声明**，要么由边缘层**覆盖**为最外层
    专用头的值。另记一条易踩的 nginx 语义：`proxy_set_header` 的继承是「本级只要出现任何一条、
    上层全部不继承」，写错层级会**静默丢弃**该行，退化成「XFF 原样透传」这一最不安全形态。
  - §2 的变量说明与 §4 要求④同步补上「只填代理自身网段」这一前提（分桶会跳过该网段内的跳），
    并要求反代按**拓扑**设置 XFF，而非一律「显式设置」。
- **补齐隧道形态的转发头与限流分桶口径**（`RECEIVER_SETUP.md` §6 / §7 / §9、`RELAY_DEPLOY.md` §5）。
  运行手册此前**完全没提** `RELAY_TRUSTED_PROXIES`，而它恰好是「全班共用一个限流桶」与正常形态的
  分界线：隧道把请求转给本机时 socket 对端恒为 `127.0.0.1`，不声明就按 socket 分桶。
  新增 §9「链路自检」介绍三条探针，并在排错表补「全班一起 429」一行。
- `shared/relay-base-url.js` 与 `.env.example` 里「CI 门禁跑在 shell 里、无法复用该模块、
  是唯一需人肉同步的一处」的说法同步删除 —— 该副本已不存在。

### Removed

- **15 个环境变量形态的调参旋钮**（改为 `relay-config.js` 的模块常量，见上方 Changed 节）：
  `MAX_TEXT_BYTES` / `MAX_BODY_BYTES` / `MAX_QUEUE_EVENTS` / `MAX_ROOM_UPLOADS` /
  `MAX_UPLOAD_NAME_BYTES` / `MAX_ROOMS` / `MAX_UPLOAD_BYTES_PER_WINDOW` /
  `MAX_ROOM_BYTES_PER_WINDOW` / `MAX_ROOM_UPLOAD_BYTES` / `ROOM_TTL_MS` / `ROOM_MAX_LIFETIME_MS` /
  `ROOM_CLEANUP_INTERVAL_MS` / `STREAM_TICKET_TTL_MS` / `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`。
  在 `.env` 里保留它们不会有任何效果（也不报错）；等价能力见 `RELAY_TUNING`。
- **房间目录归属标记 `.coolector-room` 与「无主目录回收」整体移除**（约 92 行补偿逻辑）：
  它们是「房间只在内存」这一前提下的产物 —— 既然磁盘上的目录无法证明归属，就只能在
  启动时按标记判断「能否删」。`room.json` 取代了这两件事：它**既是**归属证明（含
  `generator` / `version` / `roomId` 三重自校验），**又是**恢复依据。
  随之删除的还有 `RELAY_KEEP_ORPHAN_UPLOADS` 旋钮（不再有「保留无主目录」这回事）与
  `measureDirectoryBytes`（不再需要按目录求和来估算配额，配额由元数据里的 `quotaBytes` 复原）。
  行为变化：`UPLOAD_DIR` 下无法识别的目录从「被回收」变为「被跳过 + 告警」，需人工清理。
- **`scripts/receiver.mjs`（内网穿透一键编排）**。它的职责是「自动开两条隧道、把随机前端地址写进
  `.env`」—— 前提是前端也经隧道暴露。ngrok 免费档只有 1 个域名，该前提已不成立（见上方 Changed 节），
  脚本剩下的能力与文档 §4 的两条命令等价。引用一并清理：README 的目录树、`.env.example` 的说明、
  `.gitignore` 里的 `scripts/.receiver-runtime.json`。
- `deploy.yml` 中 shell `case` 形式的 `VITE_RELAY_URL` 判据副本（并入共享判据，见 Fixed）。

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
- `README` 结构树、`/relay` 子路径说法、nginx `client_max_body_size` 说明（13.4MB → 15.16MB）等
  文档漂移一并修正

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
- **密钥泄露 CI 守卫** `pnpm guard:no-secret`
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
- `RELAY_ALLOWED_ORIGINS` 空值不再导致 CORS 头缺失
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
