# Single image, two entrypoints (web: `npm start`, worker: `npm run worker`).
# Railway builds this once and runs it as both services with different start commands.
FROM node:20-slim AS base
# ffmpeg is needed by the worker for assembly.compose / encode.final (CPU only).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# --- build (Next.js) ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# Default command is web; the worker service overrides this with `npm run worker`.
CMD ["npm", "start"]
