# ===== 后端镜像：Node + Express + Prisma =====
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ===== 生产依赖瘦身阶段 =====
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/gmp.db"

# 生产依赖（Prisma Client 需要在生成后拷贝）
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 编译产物
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma

# 初始化脚本以 tsx 运行需要 devDependency，这里改用已编译的 JS：
# 通过 tsc 编译 prisma/seed.ts 后位于 dist/prisma/seed.js
COPY --from=builder /app/dist/prisma ./dist/prisma

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
