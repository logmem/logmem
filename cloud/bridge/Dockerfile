# acmi-bridge: one jailed Redis REST bridge per ACMI Cloud tenant.
# Build from the repository root:
#   docker build -f cloud/bridge/Dockerfile -t acmi-bridge:0.1.0 .
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Only the Redis client is needed at runtime (redis:// upstreams). Installed
# from the lockfile, no lifecycle scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Bridge, the shared Redis runners it uses, and (when present) the meter and plans.
COPY src/lib ./src/lib
COPY src/http ./src/http
COPY cloud ./cloud

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ACMI_BRIDGE_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "cloud/bridge/main.mjs"]
