# Coolector

![typescript](https://img.shields.io/badge/typescript-5.7+-blue.svg)
![vue](https://img.shields.io/badge/vue-3.5+-brightgreen.svg)
![pinia](https://img.shields.io/badge/pinia-3.0+-ff6b6b.svg)
![vite](https://img.shields.io/badge/vite-8.0+-yellow.svg)
![tailwind](https://img.shields.io/badge/tailwind-4.0+-38bdf8.svg)

Coolector 是一个现代化的文件收集器。

## 主要功能

- [x] 文件上传
  - [x] 支持 .md, .ipynb, .docx
  - [x] 支持批量上传
- [x] 拖拽上传和点击上传
- [x] 文件名校验
  - [x] 自定义文件名范式
  - [x] 校验文件名是否符合要求
- [x] 自动化文件信息提取
  - [x] 文件大小、类型、应用记录时间
  - [x] 从文件名中提取学号、姓名等信息
- [x] 读取收集名单并检查提交状态
- [x] 响应式设计
  - [x] 支持网页端
  - [x] 支持移动端

## 技术栈

- **前端框架**: Vue.js 3.5 (Composition API)
- **编程语言**: TypeScript 5.7+
- **状态管理**: Pinia 3.0+
- **构建工具**: Vite 8.0+
- **样式框架**: Tailwind CSS 4.0+
- **UI 组件**: 自定义组件 + Tailwind 工具类

## 开发指南

### 环境要求

- Node.js >=22.0
- pnpm >= 11.0

### 安装依赖

```bash
pnpm install
```

### 开发服务器

```bash
pnpm run dev
```

应用将在 <http://localhost:5174> 启动

### 快速启动前端和 Relay

```bash
pnpm start
```

默认同时启动：

- 前端应用：<http://localhost:5174>
- Relay Server：<http://localhost:8787>

可通过环境变量自定义端口：

```bash
APP_PORT=3000 RELAY_PORT=9000 pnpm start
```

### 构建项目

```bash
pnpm run build
```

构建产物将输出到 `dist/` 目录

### 预览构建结果

```bash
pnpm run preview
```

### 启动 Relay Server

```bash
pnpm run relay
```

默认监听 `http://localhost:8787`

## 项目结构

```text
src/
├── components/          # Vue 组件
│   ├── FileUploader.vue    # 文件上传组件
│   ├── CollectionStatus.vue # 收集状态组件
│   └── FileViewer.vue      # 文件预览组件
├── stores/             # Pinia 状态管理
│   ├── index.ts        # 状态管理入口
│   ├── file.ts         # 文件相关状态
│   └── collection.ts   # 收集列表状态
├── App.vue            # 根组件
├── main.ts            # 应用入口
└── style.css          # 全局样式
```

## 核心功能

### 文件上传

- [x] 支持拖拽上传和点击上传
- [x] 支持多文件同时上传
- [x] 显示文件大小、类型等信息

### 收集名单管理

- [x] 上传包含文件名的列表文件
- [x] 实时跟踪收集进度
- [x] 状态标记：待收集、已收集、错误
- [x] 可视化进度条显示

### 文件预览

- [x] 查看上传文件的内容
- [x] 标记文件为已收集状态
- [x] 显示文件详细信息

## 跨公网传输

- [x] 公网 Relay Server
- [x] Receiver 长连接
- [x] HTTP 上传
- [x] Relay 内存转发
- [x] 服务端保存并下载客户端上传文件

Relay 收到客户端上传后会把文件保存到 `server/uploads/<roomId>/`，并返回可下载地址：

```text
GET /api/rooms/:roomId/uploads/:uploadId?download=1
```

也可以通过房间状态查看上传文件和下载链接：

```bash
curl http://localhost:8787/api/rooms/demo-room
```

## 使用说明

1. **上传文件**: 点击或拖拽文件到上传区域
2. **上传收集名单**: 上传包含目标文件名的文本文件
3. **查看收集状态**: 实时查看收集进度和状态
4. **预览文件**: 点击文件查看详细内容
5. **标记完成**: 在文件预览中标记为已收集

## 开发特性

- 🎯 完整的 TypeScript 类型支持
- 🎨 现代化的响应式设计
- ⚡ 快速的开发体验（Vite HMR）
- 📱 移动端友好的界面
- 🔧 模块化的组件架构
- 📊 实时的状态管理
