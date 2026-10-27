# filuflow: Node 22 slim, runs as the non-root user "node"
# Build stage with the full image: contains python3, make and g++ for node-gyp in case better-sqlite3 finds no
# matching prebuild (e.g. arm64, new Node version). Same Debian as node:22-slim, therefore compatible.
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
# Python (Native) in the Code node needs a Python interpreter: docker build --build-arg WITH_PYTHON=true .
# Python (Pyodide) runs without one, it ships in node_modules.
ARG WITH_PYTHON=false
RUN if [ "$WITH_PYTHON" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*; fi
# credentials.json and vars.json are optional and live in the working directory /data
# (FILUFLOW_CREDENTIALS or FILUFLOW_VARS would make the respective file mandatory)
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
# /data/state exists in the image so that a named volume mounted there (compose files) belongs to "node"
RUN mkdir -p /data/workflows /data/state && chown -R node:node /data
WORKDIR /data
USER node
VOLUME ["/data"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FILUFLOW_PORT||5678)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/bin/filuflow.js", "serve"]
