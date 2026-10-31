# niho-desktop-bridge

Mac の殻（`apps/docs`。設計 [§13](../../docs/architecture/editor-niho-life-design.md)）が editor.niho.life に見せる **command の型付きの包み**。
ブラウザ・PWA・Mac アプリは同じ画面を描き、Mac の殻の中だけ「この Mac で」の選択肢（録音・端末内の文字起こし・CLI の AI）が増える。
その入口がこの package。

- **Tauri の import は `src/tauri-shell-transport.ts` だけ。** `packages/docs-ui` は Tauri-free のまま（`isolation.test.ts`）。
- **id だけ**でやり取りし、パスは画面に来ない。結果（音声・文字起こし・AI の差分）を**サーバーへ書くのは画面**（native はサーバーの API に触らない）。
- command の一覧は Rust の `apps/docs/src-tauri/permissions/docs.toml` の `allow-editor-shell` と **テストで突き合わせる**（`src/shell-contract.test.ts`。片方だけ増えると落ちる）。

## 使い方（editor-web）

```json
"niho-desktop-bridge": "file:../../packages/desktop-bridge"
```

```ts
import { detectShell } from "niho-desktop-bridge/tauri-shell-transport";

const shell = detectShell(); // Mac の殻の中なら bridge、ブラウザ・PWA・SSR なら null
if (shell) {
  const { features } = await shell.capabilities();
  if (features.cliAi) {
    const engines = await shell.aiEngines(); // 「この Mac で（Claude Code …）」の選択肢とモデルの一覧
  }
}
```

- 録音：`recordingStart(recordingId, onEvent)` → `recordingStop` → `recordingRead` のバイト列をサーバーへ上げる → `recordingDiscard`。
- 音声ファイル：`audioPick()` → `audioRead(stagingId, index)` → `stagingDiscard`。
- 端末内の文字起こし：`transcribeLocal(jobId, source, { language, speakerMode, hints }, onEvent)` → `ShellTranscript[]` を録音 API へ。
- CLI の AI：`aiTurn(turnId, { engine, model, effort?, conversationId?, resumeSession?, instruction, page, context? }, onEvent)` →
  `page.markdown` を `POST /api/pages/{id}/ai/chat/turns` の `writes[0]` に、`finalEvent.text` を `reply` に、`engine` はそのまま。
  `finalEvent.session_id` を次の `resumeSession` に。実行中は画面の編集を止める（設計 §6.1）。

型は `niho-desktop-bridge/shell-contract`。偽の transport でテストするときは `createShellBridge(transport)`（`shell-bridge.test.ts` を参照）。

## 開発

```sh
npm -C packages/desktop-bridge ci
npm -C packages/desktop-bridge run typecheck && npm -C packages/desktop-bridge run lint && npm -C packages/desktop-bridge test
```
