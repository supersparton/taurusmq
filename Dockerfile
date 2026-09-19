# TaurusMQ API — observability API server (OBS_PORT, default 4000).
# Dashboard UI has its own image (Dockerfile.dashboard) and proxies
# /api/* + /ws here, so this service is never exposed publicly directly.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY packages ./packages
COPY scripts ./scripts

EXPOSE 4000
ENV NODE_ENV=production \
    OBS_PORT=4000

CMD ["node", "scripts/start-api.js"]
