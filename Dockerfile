# Single image used for both the web app and the daily worker
# (docker-compose picks the command for each service).
FROM node:20-bookworm-slim AS base
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM base AS build
# Dummy value: docker-compose's "environment:" only applies to the running
# container, never to the build stage. Prisma generate / next build only
# need DATABASE_URL to be *present* to resolve env("DATABASE_URL") in the
# schema — they don't actually connect to a database at this point. The
# real value is injected at runtime via docker-compose.
ENV DATABASE_URL="postgresql://user:password@localhost:5432/dailyspoon?schema=public"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/worker ./worker
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["web"]
