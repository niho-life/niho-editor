import { describe, expect, it, vi } from "vitest";
import { GoogleDocsBatchQueue, GOOGLE_DOCS_DISPATCH_DEADLINE_SECONDS, GOOGLE_DOCS_RUN_PATH, googleDocsBatchTaskName } from "./batch-queue";

const JOB = "00000000-0000-4000-8000-000000000001";
const config = {
  queue: "projects/synthetic-project/locations/test-region/queues/google-docs",
  workerUrl: "https://editor.example.test",
  invokerServiceAccount: "worker@synthetic-project.iam.gserviceaccount.com",
};

describe("Google Docs batch Cloud Tasks envelope", () => {
  it("task名をjob/generation/dispatch attemptで変え、本文はjobId/generationだけにする", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("metadata.google.internal")) {
        return new Response(JSON.stringify({ access_token: "synthetic-access", expires_in: 300 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const queue = new GoogleDocsBatchQueue(config, { fetch, now: () => Date.parse("2030-01-01T00:00:00.000Z") });
    await expect(queue.enqueue({ jobId: JOB, generation: 7, dispatchAttempt: 3 })).resolves.toEqual({ deduplicated: false });
    const request = JSON.parse(String(calls[1]!.init?.body)) as { task: { name: string; dispatchDeadline: string; httpRequest: { url: string; body: string; oidcToken: unknown } } };
    expect(request.task.name).toBe(`${config.queue}/tasks/${googleDocsBatchTaskName(JOB, 7, 3)}`);
    expect(request.task.dispatchDeadline).toBe(`${GOOGLE_DOCS_DISPATCH_DEADLINE_SECONDS}s`);
    expect(request.task.httpRequest.url).toBe(`${config.workerUrl}${GOOGLE_DOCS_RUN_PATH}`);
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body, "base64").toString("utf8"))).toEqual({ jobId: JOB, generation: 7 });
    expect(request.task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: config.invokerServiceAccount, audience: config.workerUrl });
    expect(googleDocsBatchTaskName(JOB, 7, 4)).not.toBe(googleDocsBatchTaskName(JOB, 7, 3));
  });

  it("不正identityを外部呼出し前に拒否する", async () => {
    const fetch = vi.fn();
    const queue = new GoogleDocsBatchQueue(config, { fetch: fetch as typeof globalThis.fetch });
    expect(() => queue.enqueue({ jobId: "not-a-job", generation: 1, dispatchAttempt: 1 })).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
