# ===== 后端镜像：Express + Prisma + SQLite =====
#
# 为什么用 node:22-bookworm-slim（Debian）而不是 alpine：
#   ★ 本项目依赖 better-sqlite3 原生模块。alpine 的 musl libc
#     与其预编译包不兼容，必须源码编译，慢且在生产环境容易失败。
#     bookworm 是 glibc，直接用预编译包，构建快且稳定。
#
# 为什么两阶段构建：
#   第一阶段装完整依赖（含编译工具链）并编译 TS；
#   第二阶段只装生产依赖，镜像小一半以上，且不需要编译器。

# ---------- 第一阶段：构建 ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 编译 better-sqlite3 需要 python3 + make + g++
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先只拷依赖清单，改代码时这一层可复用缓存
COPY package*.json ./
COPY prisma ./prisma
RUN npm install --no-audit --no-fund

# 拷源码并编译
COPY tsconfig.json ./
COPY src ./src
COPY extract-focus.ts ./extract-focus.ts
RUN npx prisma generate && npm run build


# ---------- 第二阶段：运行 ----------
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=file:/data/gmp.db

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 生产依赖（含 better-sqlite3 原生模块）
COPY package*.json ./
COPY prisma ./prisma
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 编译产物
COPY --from=builder /app/dist ./dist

# 数据目录：用 volume 挂载，容器重建不丢业务数据
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

# 健康检查：compose 里 web 服务依赖此healthy 状态
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 启动前先按 schema 建表（幂等，首次自动建库）
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
