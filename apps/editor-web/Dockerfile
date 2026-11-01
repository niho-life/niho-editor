# editor.niho.life の Cloud Run 用の image（niho-experience の Dockerfile と同じ形: digest 固定の node、standalone 出力）。
# 秘密を持たずに、レビュー済みの commit から作る。環境の値（EDITOR_AUTH_MODE・DATABASE_URL など）は配備のときに渡す。
# build context はリポジトリのルート: docker build -f apps/editor-web/Dockerfile .
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
# install-links（apps/editor-web/.npmrc）で packages/* を複製して入れるので、依存の packages は中身ごと先に置く
COPY packages/docs-core packages/docs-core
COPY packages/docs-ui packages/docs-ui
COPY packages/ui packages/ui
COPY packages/editor-store packages/editor-store
# 写真の本人型を直接参照する。runtime importは無いがbuildの型検査には必要。
COPY packages/photo-library-contract packages/photo-library-contract
COPY packages/editor-publish-contract packages/editor-publish-contract
COPY packages/editor-publish packages/editor-publish
# The lifecycle adapter imports this worker executor into the server build graph.
COPY workers/photo-purge workers/photo-purge
COPY apps/editor-web/package.json apps/editor-web/package-lock.json apps/editor-web/.npmrc apps/editor-web/
RUN npm -C apps/editor-web ci --no-audit --no-fund
COPY apps/editor-web apps/editor-web
RUN npm -C apps/editor-web run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo/apps/editor-web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/editor-web/.next/static ./.next/static
# standalone の出力には public/ が入らない（manifest・アイコン・service worker・オフライン画面）。build の後処理でも置くが、image に入ることをここで明示する
COPY --from=build --chown=node:node /repo/apps/editor-web/public ./public
# 起動の入口: server を読み込む前に認証の方式を検査する（EDITOR_AUTH_MODE=niho 以外は起動しない）
COPY --from=build --chown=node:node /repo/apps/editor-web/scripts/server-entry.mjs ./scripts/server-entry.mjs
COPY --from=build --chown=node:node /repo/apps/editor-web/src/auth/config.ts ./src/auth/config.ts
USER node
EXPOSE 8080
CMD ["node", "scripts/server-entry.mjs", "server.js"]
