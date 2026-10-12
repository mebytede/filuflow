# flowlite: Node 22 slim, läuft als Nicht-root-Benutzer "node"
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    FLOWLITE_DIR=/data/workflows \
    FLOWLITE_DB=/data/flowlite.db \
    FLOWLITE_CREDENTIALS=/data/credentials.json \
    FLOWLITE_VARS=/data/vars.json \
    FLOWLITE_BINARY_DIR=/data/binary \
    FLOWLITE_PORT=5678
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
RUN mkdir -p /data/workflows && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLOWLITE_PORT||5678)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bin/flowlite.js", "serve"]
