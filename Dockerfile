FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/app/data/grok-art-proxy.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY static ./static
COPY migrations ./migrations

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["npm", "run", "start"]
