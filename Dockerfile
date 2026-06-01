# node:20-slim (Debian/glibc) — better-sqlite3 nécessite un module natif
FROM node:20-slim

WORKDIR /app

# Outils de build pour compiler better-sqlite3 si aucun prebuild ne correspond
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js db.js poller.js compute.js sensors.js ./
COPY public/ ./public/

# Répertoire de persistance de la base SQLite (monté en volume)
RUN mkdir -p /data
ENV DB_PATH=/data/energie.db

EXPOSE 3000

CMD ["node", "server.js"]
