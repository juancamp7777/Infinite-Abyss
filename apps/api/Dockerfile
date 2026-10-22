FROM node:20-alpine

WORKDIR /app

# Prisma necesita openssl en Alpine
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npx prisma generate

ENV NODE_ENV=production
ENV LOG_DIR=/app/logs
EXPOSE 4000

# Directorio de registros escribible por el usuario no root
RUN mkdir -p /app/logs && chown -R node:node /app/logs

USER node

# Migraciones reales (nunca db push)
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/server.ts"]
