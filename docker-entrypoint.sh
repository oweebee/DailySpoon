#!/bin/sh
set -e

# Apply pending Prisma migrations before starting anything. Safe to run
# from both the "web" and "worker" service on boot — it's idempotent.
echo "[entrypoint] Running prisma migrate deploy..."
npx prisma migrate deploy

case "$1" in
  web)
    echo "[entrypoint] Starting Next.js web server..."
    exec npm run start
    ;;
  worker)
    echo "[entrypoint] Starting daily edition worker..."
    exec npm run worker
    ;;
  *)
    echo "[entrypoint] Unknown command: $1 (expected 'web' or 'worker')"
    exec "$@"
    ;;
esac
