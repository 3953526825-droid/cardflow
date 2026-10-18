# AnkiCardMaker —— 零 npm 依赖，所以不需要 npm ci，源码拷进去就能跑。
# 密钥不进镜像：config/ 由 docker-compose 用卷挂载进来。
FROM node:22-slim

WORKDIR /app

COPY package.json README.md ./
COPY src ./src
COPY public ./public
COPY prompts ./prompts
COPY subjects ./subjects

# 容器里没有 cert.pfx，HTTPS 会自动禁用（要 HTTPS 就把 cert.pfx 挂进来）
ENV ANKI_HOST=0.0.0.0 \
    NODE_ENV=production
EXPOSE 3210

# /api/config 免口令，用它做健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/api/config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
