FROM node:22.16.0-bookworm-slim
WORKDIR /app
COPY backend/dist ./backend/dist
COPY backend/package.json ./backend/package.json
COPY web ./web
COPY release-manifest.json ./release-manifest.json
ENV NODE_ENV=production \
    PORT=8787 \
    GEARBEACON_DEPLOYMENT=cloud \
    GEARBEACON_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "backend/dist/index.js"]
