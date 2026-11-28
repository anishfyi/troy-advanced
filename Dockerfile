FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

ENV TROY_CHROME_BIN=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY deploy ./deploy
RUN npm run build && chmod +x bin/troy-advanced.mjs

VOLUME ["/data", "/root/.config/troy-advanced"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${TROY_AGENT_PORT:-9333}/readyz" >/dev/null || exit 1

ENTRYPOINT ["node", "/app/bin/troy-advanced.mjs"]
CMD ["daemon", "run", "--engine", "auto", "--port", "9333", "--profile", "/data/profile", "--endpoint", "/data/agent-endpoint.json", "--compat-troy"]
