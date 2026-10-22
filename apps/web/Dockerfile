# ── build ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
ARG NEXT_PUBLIC_API_URL=/api-proxy
ARG NEXT_PUBLIC_SOCKET_URL=
ARG NEXT_PUBLIC_SOCKET_PATH=
ARG NEXT_PUBLIC_GAME_FRAME_ORIGINS=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL \
    NEXT_PUBLIC_SOCKET_PATH=$NEXT_PUBLIC_SOCKET_PATH \
    NEXT_PUBLIC_GAME_FRAME_ORIGINS=$NEXT_PUBLIC_GAME_FRAME_ORIGINS \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime ──
FROM node:22-alpine AS runtime
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=/api-proxy
ARG NEXT_PUBLIC_GAME_FRAME_ORIGINS=
# Destino interno de la rewrite /api-proxy/* (runtime). Las rewrites se leen de next.config.ts.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    API_INTERNAL_URL=http://api:4000 \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_GAME_FRAME_ORIGINS=$NEXT_PUBLIC_GAME_FRAME_ORIGINS
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
USER node
EXPOSE 3000
CMD ["npm", "start"]
