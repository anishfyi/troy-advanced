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

VOLUME ["/root/.config/troy-advanced"]

ENTRYPOINT ["node", "/app/bin/troy-advanced.mjs"]
CMD ["daemon", "run", "--engine", "auto", "--compat-troy"]
