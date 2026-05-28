# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Compile static Next.js frontend
COPY streamcap/package*.json ./streamcap/
RUN cd streamcap && npm install --ignore-scripts
COPY streamcap/ ./streamcap/
RUN cd streamcap && npm run build

# Compile TypeScript backend
COPY package*.json tsconfig.json tsup.config.ts ./
RUN npm ci --ignore-scripts
COPY src/ ./src
RUN npm run build

# --- Production Stage ---
FROM node:20-alpine
WORKDIR /app

# Install system dependencies (FFmpeg is required for lossless FLV -> MP4 conversion)
RUN apk add --no-cache ffmpeg

# Copy lockfiles and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled ESM / CJS modules from build stage
COPY --from=builder /app/dist ./dist

# Copy Next.js static site compiled files into miniapp
COPY --from=builder /app/streamcap/out ./temp_miniapp
RUN if [ -d ./temp_miniapp/miniapp ]; then \
      mv ./temp_miniapp/miniapp ./miniapp && rm -rf ./temp_miniapp; \
    else \
      mv ./temp_miniapp ./miniapp; \
    fi

# Create recording output directory
RUN mkdir -p /app/recordings

# Expose output directory as a volume for persistence
VOLUME ["/app/recordings"]

# Expose API server port for mini app
EXPOSE 3000

# Set default environmental flags
ENV NODE_ENV=production \
    OUTPUT_DIR=/app/recordings \
    INTERVAL_MINUTES=5 \
    MAX_PARALLEL_RECORDINGS=3 \
    API_PORT=3000 \
    GDRIVE_CLIENT_ID= \
    GDRIVE_CLIENT_SECRET= \
    GDRIVE_REFRESH_TOKEN= \
    GDRIVE_FOLDER_ID=

# Launch the recorder process
CMD ["node", "dist/runner.js"]
