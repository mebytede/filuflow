# filuflow: Node 22 slim, läuft als Nicht-root-Benutzer "node"
# Build-Stufe mit dem vollen Image: enthält python3, make und g++ für node-gyp, falls better-sqlite3 kein
# passendes Prebuild findet (z. B. arm64, neue Node-Version). Gleiches Debian wie node:22-slim, daher kompatibel.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.ui.json ./
COPY src ./src
COPY bin ./bin
COPY scripts/copy-ui-assets.mjs ./scripts/
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# Python (Native) im Code-Node braucht einen Python-Interpreter: docker build --build-arg WITH_PYTHON=true .
# Python (Pyodide) läuft ohne, es steckt in node_modules.
ARG WITH_PYTHON=false
RUN if [ "$WITH_PYTHON" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*; fi
# credentials.json und vars.json sind optional und liegen im Arbeitsverzeichnis /data
# (FILUFLOW_CREDENTIALS bzw. FILUFLOW_VARS würden die Datei verpflichtend machen)
ENV NODE_ENV=production \
    FILUFLOW_DIR=/data/workflows \
    FILUFLOW_DB=/data/filuflow.db \
    FILUFLOW_BINARY_DIR=/data/binary \
    FILUFLOW_PORT=5678 \
    FILUFLOW_PYTHON_PACKAGES_DIR=/data/pyodide
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
RUN mkdir -p /data/workflows && chown -R node:node /data
WORKDIR /data
USER node
VOLUME ["/data"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FILUFLOW_PORT||5678)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/bin/filuflow.js", "serve"]
