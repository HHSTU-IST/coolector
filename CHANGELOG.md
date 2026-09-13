# Changelog

本项目所有值得记录的变更都会写入本文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-13

首个正式版本，基于上线前全检（代码审查 + 安全审计 + QA 测试）完成安全与质量加固。

### Security

- Relay 鉴权改为 fail-closed：未设置 `RELAY_TOKEN` 且监听非回环地址时拒绝启动
- SSE 改用一次性短时效票据（`POST /api/rooms/:roomId/stream-ticket`），避免长期 token 进入 URL（日志 / Referer / 浏览器历史）
- 上传落盘目录磁盘配额在启动时按实际磁盘占用初始化，防止进程重启绕过配额
- Relay 增加固定窗口速率限制（默认 60 秒 120 次 / 来源 IP），超限返回 429
- 移除 API 响应中的服务端存储文件名与上传目录绝对路径
- 未知内部错误统一模糊为 `Bad request`，内部细节只写入结构化安全审计日志
- `x-forwarded-proto` / `x-forwarded-host` 仅在 `RELAY_TRUST_PROXY=true`（可信代理后）才采信

### Fixed

- Relay 接收端在 SSE 只推送元信息后丢失文件全文与二进制内容（改为按 `detailsUrl` 按需拉取正文）
- 文件名范式 ReDoS 拦截遗漏嵌套可选量词（如 `(a?)*`、`(\w+\s?)*`）
- docx 解压增加 64 MB 膨胀上限，防止压缩炸弹导致内存耗尽
- `docker-compose` 的 `RELAY_ALLOWED_ORIGINS` 空值不再导致 CORS 头缺失

### Changed

- 房间 ID 默认改为完整 `randomUUID()`（128 bit 熵），替代原先 8 位十六进制
- 构建期依赖（Tailwind / PostCSS / autoprefixer）从 `dependencies` 迁至 `devDependencies`
- 移除未使用的 `@tailwindcss/typography` 依赖
- 统一 `formatFileSize` / `formatDate` 实现到 `src/utils/format.ts`

### Added

- Relay Server 单元测试（`server/relay-utils.test.js`），并抽离可测试纯函数到 `server/relay-utils.js`
- 项目版本号与 CHANGELOG

### CI

- CI 增加 `lint` 与单元测试步骤（原先仅 typecheck + build）
- 发布流程改用 `softprops/action-gh-release@v2` 并自动生成 release notes
- GitHub Pages 部署仅在 push 到主分支时触发
