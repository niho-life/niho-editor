import { resolveTaskQueueConfig, type TaskQueueConfig } from "../server/cloud-tasks";
import { resolveGoogleDocsConfig, type GoogleDocsEnv } from "./config";

export type GoogleDocsBatchMode = "off" | "cloud-tasks";
export type GoogleDocsBatchEnv = GoogleDocsEnv & {
  readonly EDITOR_GOOGLE_DOCS_BATCH_MODE?: string;
  readonly EDITOR_GOOGLE_DOCS_QUEUE?: string;
  readonly EDITOR_GOOGLE_DOCS_WORKER_URL?: string;
  readonly EDITOR_GOOGLE_DOCS_INVOKER_SERVICE_ACCOUNT?: string;
  readonly EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE?: string;
  readonly EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED?: string;
};

export type GoogleDocsBatchConfig = { mode: "off" } | {
  mode: "cloud-tasks";
  queue: TaskQueueConfig;
  nihoApiBase: string;
  nihoAudience: string;
};

export class GoogleDocsBatchConfigError extends Error {
  override readonly name = "GoogleDocsBatchConfigError";
}

function audience(value: string | undefined, apiBase: string): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || value !== url.href.replace(/\/$/, "")) return null;
  const expected = new URL(apiBase);
  const expectedPath = `${expected.pathname.replace(/\/+$/, "")}/internal/editor-docs-drive`;
  // The NIHO API base can use a public alias while its OIDC verifier pins the canonical API audience.
  return url.pathname === expectedPath ? value : null;
}

export function resolveGoogleDocsBatchConfig(env: GoogleDocsBatchEnv): GoogleDocsBatchConfig {
  const raw = env.EDITOR_GOOGLE_DOCS_BATCH_MODE?.trim() ?? "";
  if (raw === "" || raw === "off") return { mode: "off" };
  if (raw !== "cloud-tasks") throw new GoogleDocsBatchConfigError("EDITOR_GOOGLE_DOCS_BATCH_MODE must be one of: cloud-tasks, off");
  const single = resolveGoogleDocsConfig(env);
  const queue = resolveTaskQueueConfig(env, {
    queue: "EDITOR_GOOGLE_DOCS_QUEUE",
    workerUrl: "EDITOR_GOOGLE_DOCS_WORKER_URL",
    invokerServiceAccount: "EDITOR_GOOGLE_DOCS_INVOKER_SERVICE_ACCOUNT",
  });
  const nihoAudience = single.mode === "niho" ? audience(env.EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE, single.apiBase) : null;
  if (single.mode !== "niho" || !queue || !nihoAudience || env.EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED !== "true") {
    throw new GoogleDocsBatchConfigError("Google Docs batch runtime is incomplete");
  }
  return { mode: "cloud-tasks", queue, nihoApiBase: single.apiBase, nihoAudience };
}
