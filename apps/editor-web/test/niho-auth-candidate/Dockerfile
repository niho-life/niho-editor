ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY apps/editor-web/src/auth apps/editor-web/src/auth
COPY apps/editor-web/src/server/http.ts apps/editor-web/src/server/auth-routes.ts apps/editor-web/src/server/
COPY apps/editor-web/src/server/photo-auth/index.ts apps/editor-web/src/server/photo-auth/index.ts
COPY apps/editor-web/test/niho-auth-candidate apps/editor-web/test/niho-auth-candidate
WORKDIR /repo/apps/editor-web/test/niho-auth-candidate
ARG SOURCE_COMMIT
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN SOURCE_COMMIT="${SOURCE_COMMIT}" npm run build && npm test

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production EDITOR_AUTH_MODE=niho PORT=8080
COPY --from=build --chown=node:node /repo/apps/editor-web/test/niho-auth-candidate/dist ./
USER node
EXPOSE 8080
CMD ["node", "--conditions=react-server", "server.mjs"]
