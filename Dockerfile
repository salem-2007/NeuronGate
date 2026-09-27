# WorkersAI2API - Docker 镜像
# 零依赖：只用 Node 内置模块（http/fs/stream + 全局 fetch）。
FROM node:22-alpine

WORKDIR /app

# 只有 package.json，无第三方依赖，无需 npm install
COPY package.json ./
COPY _worker.js ./
COPY server.mjs ./

# KV 持久化目录（挂 volume 到这里以跨重启保留配置）
RUN mkdir -p /data
ENV KV_PATH=/data/kv.json
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

# 用非 root 运行，并把 /data 交给它
RUN chown -R node:node /app /data
USER node

# 健康检查：首页返回 200 即视为健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
