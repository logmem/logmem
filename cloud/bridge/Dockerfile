# acmi-bridge: one jailed Redis REST bridge per ACMI Cloud tenant.
# Build from the repository root (see /.dockerignore):
#   docker build -f cloud/bridge/Dockerfile -t acmi-bridge:0.1.0 .
#
# Base pinned by digest: the multi-arch index of node:22-alpine, read from the
# Docker Hub registry API on 2026-10-14 (HEAD /v2/library/node/manifests/22-alpine).
# To bump: `docker buildx imagetools inspect node:22-alpine` and replace the digest.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV NODE_ENV=production
WORKDIR /app

# Zero runtime dependencies: nothing is installed. The bridge speaks RESP
# itself (cloud/bridge/resp.mjs); the REST upstream uses src/lib/redis-rest.mjs.
COPY src/lib ./src/lib
COPY cloud/bridge ./cloud/bridge
COPY cloud/meter ./cloud/meter
COPY cloud/tenants ./cloud/tenants
COPY cloud/plans.json ./cloud/plans.json

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ACMI_BRIDGE_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "cloud/bridge/main.mjs"]
