# The self-host bundle's server image (job personal-selfhost-bundle).
# Build context is the repo root:  docker build -f selfhost/Dockerfile .
#
# Runtime surface: selfhost/serve.mjs mounts api/, vercel.json and public/,
# so the image needs exactly those trees plus scripts/ (api routes import it)
# and cloud/ (tenants + plans.json).

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# Full install, not --omit=dev: src/http/clerk.mjs imports @clerk/backend at
# module load and api/login, api/session and api/sign-in import it — sign-in
# would break without it. @clerk/backend is a devDependency on purpose (the
# published npm package never loads api/ routes), but this image serves them.
# --ignore-scripts skips playwright's browser download; no test runs here.
RUN npm ci --ignore-scripts

COPY vercel.json ./
COPY api ./api
COPY src ./src
COPY cloud ./cloud
COPY public ./public
COPY scripts ./scripts
COPY selfhost/serve.mjs ./selfhost/serve.mjs

USER node
EXPOSE 3899

# SERVER_PORT is the container-side port; compose publishes it on loopback.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||3899)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "selfhost/serve.mjs"]
