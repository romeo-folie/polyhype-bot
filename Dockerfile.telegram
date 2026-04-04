# Telegram Monitor Dockerfile (arm64/Raspberry Pi compatible)
FROM node:20-slim

# Install procps/ca-certificates if needed for slim image
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifest
COPY package*.json ./

# Install only production dependencies (prebuilt-tdlib native binary included)
RUN npm ci --omit=dev

# Copy project source and tsconfig
COPY . .

# Persistence volume for TDLib session database
VOLUME /app/tdlib-data

# Run monitor (will prompt for code on first run if not already authenticated)
CMD ["npx", "tsx", "src/ingestion/telegramMonitor.ts"]
