ARG NODE_IMAGE=node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM build AS integration
COPY scripts ./scripts
ENTRYPOINT ["node", "scripts/forgejo-integration.mjs"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV FORGEJO_OPS_WIDGET_CALLBACK_HOST=0.0.0.0
ENV FORGEJO_OPS_WIDGET_CALLBACK_PORT=8080
WORKDIR /app
RUN mkdir -p /app/conf && chown node:node /app/conf
EXPOSE 8080
USER node
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.FORGEJO_OPS_WIDGET_CALLBACK_PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/index.js"]
