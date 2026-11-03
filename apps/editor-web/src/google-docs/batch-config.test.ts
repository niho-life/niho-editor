import { describe, expect, it } from "vitest";
import { GoogleDocsBatchConfigError, resolveGoogleDocsBatchConfig } from "./batch-config";

const complete = {
  EDITOR_GOOGLE_DOCS_MODE: "niho",
  EDITOR_NIHO_API_ORIGIN: "https://niho.example.test/api",
  EDITOR_GOOGLE_DOCS_BATCH_MODE: "cloud-tasks",
  EDITOR_GOOGLE_DOCS_QUEUE: "projects/synthetic-project/locations/test-region/queues/google-docs",
  EDITOR_GOOGLE_DOCS_WORKER_URL: "https://editor.example.test",
  EDITOR_GOOGLE_DOCS_INVOKER_SERVICE_ACCOUNT: "worker@synthetic-project.iam.gserviceaccount.com",
  EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE: "https://niho.example.test/api/internal/editor-docs-drive",
  EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED: "true",
} as const;

describe("Google Docs durable batch config", () => {
  it("未設定はoffで、cloud-tasksは既存TaskQueueConfig名と固定NIHO audienceを読む", () => {
    expect(resolveGoogleDocsBatchConfig({})).toEqual({ mode: "off" });
    expect(resolveGoogleDocsBatchConfig(complete)).toEqual({
      mode: "cloud-tasks",
      queue: {
        queue: complete.EDITOR_GOOGLE_DOCS_QUEUE,
        workerUrl: complete.EDITOR_GOOGLE_DOCS_WORKER_URL,
        invokerServiceAccount: complete.EDITOR_GOOGLE_DOCS_INVOKER_SERVICE_ACCOUNT,
      },
      nihoApiBase: complete.EDITOR_NIHO_API_ORIGIN,
      nihoAudience: complete.EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE,
    });
  });

  it("single NIHO・queue三点・HTTPS audience・共通maintenanceのどれかが無ければ起動を拒む", () => {
    for (const key of [
      "EDITOR_GOOGLE_DOCS_MODE", "EDITOR_GOOGLE_DOCS_QUEUE", "EDITOR_GOOGLE_DOCS_WORKER_URL",
      "EDITOR_GOOGLE_DOCS_INVOKER_SERVICE_ACCOUNT", "EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE", "EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED",
    ] as const) {
      const env: Record<string, string | undefined> = { ...complete, [key]: undefined };
      expect(() => resolveGoogleDocsBatchConfig(env), key).toThrow(GoogleDocsBatchConfigError);
    }
    expect(() => resolveGoogleDocsBatchConfig({ ...complete, EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE: "http://niho.example.test/internal" })).toThrow(GoogleDocsBatchConfigError);
    expect(() => resolveGoogleDocsBatchConfig({ ...complete, EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE: "https://other.example.test/api/internal/editor-docs-drive" })).toThrow(GoogleDocsBatchConfigError);
    expect(() => resolveGoogleDocsBatchConfig({ ...complete, EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE: "https://niho.example.test/api/internal/other" })).toThrow(GoogleDocsBatchConfigError);
  });

  it("未知modeを黙ってoffにせず、errorへ設定値を出さない", () => {
    try { resolveGoogleDocsBatchConfig({ EDITOR_GOOGLE_DOCS_BATCH_MODE: "secret-mode" }); }
    catch (error) {
      expect(error).toBeInstanceOf(GoogleDocsBatchConfigError);
      expect(String(error)).not.toContain("secret-mode");
      return;
    }
    throw new Error("expected config failure");
  });
});
