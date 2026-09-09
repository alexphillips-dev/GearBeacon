FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
ARG VCS_REF=unknown
ARG IMAGE_NAME=ghcr.io/alexphillips-dev/gearbeacon
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/alexphillips-dev/GearBeacon" \
      org.opencontainers.image.description="Private self-hosted Ubiquiti product monitor" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="$VCS_REF"
COPY --chown=root:root backend/dist ./backend/dist
COPY --chown=root:root web ./web
COPY --chown=root:root release-manifest.json ./release-manifest.json
RUN apk upgrade --no-cache libcrypto3 libssl3 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/pnpm \
    && mkdir -p /data \
    && chown node:node /data
ENV NODE_ENV=production \
    GEARBEACON_BUILD_COMMIT=$VCS_REF \
    GEARBEACON_IMAGE=$IMAGE_NAME \
    PORT=8787 \
    GEARBEACON_ACCESS_MODE=private \
    GEARBEACON_BIND_HOST=0.0.0.0 \
    GEARBEACON_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
USER node
CMD ["node", "--no-warnings", "backend/dist/index.js"]
