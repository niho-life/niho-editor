import { CloudTasksClient, type CloudTasksClientOptions, type TaskQueueConfig } from "../server/cloud-tasks";

export const GOOGLE_DOCS_RUN_PATH = "/api/internal/google-docs/run";
export const GOOGLE_DOCS_SWEEP_PATH = "/api/internal/google-docs/sweep";
export const GOOGLE_DOCS_DISPATCH_DEADLINE_SECONDS = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function googleDocsBatchTaskName(jobId: string, generation: number, dispatchAttempt: number): string {
  if (!UUID.test(jobId) || !Number.isSafeInteger(generation) || generation < 1
    || !Number.isSafeInteger(dispatchAttempt) || dispatchAttempt < 1) throw new TypeError("invalid Google Docs task identity");
  return `google-docs-${jobId.replaceAll("-", "")}-g${generation}-d${dispatchAttempt}`;
}

export class GoogleDocsBatchQueue {
  private readonly client: CloudTasksClient;
  constructor(config: TaskQueueConfig, options: CloudTasksClientOptions = {}) {
    this.client = new CloudTasksClient(config, options);
  }
  enqueue(input: { jobId: string; generation: number; dispatchAttempt: number }): Promise<{ deduplicated: boolean }> {
    return this.client.createHttpTask({
      name: googleDocsBatchTaskName(input.jobId, input.generation, input.dispatchAttempt),
      path: GOOGLE_DOCS_RUN_PATH,
      payload: { jobId: input.jobId, generation: input.generation },
      deadlineSeconds: GOOGLE_DOCS_DISPATCH_DEADLINE_SECONDS,
    });
  }
}
