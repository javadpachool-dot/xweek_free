# syntax=docker/dockerfile:1
# For ArvanCloud's build service, use:
#   --build-arg BASE_IMAGE=docker.arvancloud.ir/node:22-bookworm-slim
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE} AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install -g npm@11.6.2 \
 && npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ${BASE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    DATABASE_PATH=/data/xweek.db \
    TZ=Asia/Tehran
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY --from=build /app/scripts ./scripts
EXPOSE 80
CMD ["node", "out/server/server/index.js"]
