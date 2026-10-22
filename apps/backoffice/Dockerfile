# ── dependencias ──
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ──
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* se incrustan en el bundle durante el build.
ARG NEXT_PUBLIC_BASE_PATH=
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_IMG_ORIGINS=
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_BACKOFFICE_MOCK_AUTH=false
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_IMG_ORIGINS=$NEXT_PUBLIC_IMG_ORIGINS \
    API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_PUBLIC_BACKOFFICE_MOCK_AUTH=$NEXT_PUBLIC_BACKOFFICE_MOCK_AUTH \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime (usuario no root, puerto 3001) ──
FROM node:22-alpine AS runtime
WORKDIR /app
ARG NEXT_PUBLIC_BASE_PATH=
ENV NODE_ENV=production \
    BASE_PATH=$NEXT_PUBLIC_BASE_PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:3001${BASE_PATH}/login" >/dev/null || exit 1
CMD ["node", "server.js"]
