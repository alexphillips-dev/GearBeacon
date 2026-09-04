FROM node:24-alpine
ARG VCS_REF=unknown
ARG IMAGE_NAME=ghcr.io/alexphillips-dev/gearbeacon
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/alexphillips-dev/GearBeacon" \
      org.opencontainers.image.description="Private self-hosted Ubiquiti product monitor" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="$VCS_REF"
COPY --chown=node:node backend/dist ./backend/dist
COPY --chown=node:node web ./web
COPY --chown=node:node release-manifest.json ./release-manifest.json
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/pnpm \
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
