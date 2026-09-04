# 纯 Node 运行时，Relay Server 无第三方依赖，无需 npm install
FROM node:24-alpine

# 以非 root 用户运行
RUN addgroup -S relay && adduser -S relay -G relay

WORKDIR /app

# 仅拷贝 Relay Server（无依赖，无需 node_modules）
COPY server/relay-server.js ./relay-server.js

# 上传落盘目录，挂卷持久化
ENV UPLOAD_DIR=/data/uploads
ENV PORT=8787
ENV HOST=0.0.0.0
VOLUME ["/data/uploads"]

EXPOSE 8787

# 健康检查：Relay Server 暴露 GET /healthz
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1 || exit 1

USER relay

CMD ["node", "relay-server.js"]
