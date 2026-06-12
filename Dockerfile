# Dockerfile — secretary-proxy
#
# Сборка:  docker build -t telegram-secretary .
# Запуск:  docker run --env-file .env -p 18792:18792 -v ./state:/data telegram-secretary
# Или:     docker compose up -d  (см. docker-compose.yml)

FROM node:22-alpine

WORKDIR /app

# Зависимости отдельным слоем — кэшируется, пока не меняется package*.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY persona ./persona

# Стейт (переписки, pending, персоны) — в volume, переживает пересоздание контейнера
ENV STATE_DIR=/data \
    PERSONA_DIR=/app/persona \
    PORT=18792 \
    NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 18792

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18792)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
