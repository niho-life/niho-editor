/** CLI modes are closed so a typo can never turn private-payload cleanup into page deletion. */
export type PurgeMode = "trash" | "private-jobs";
export function parsePurgeMode(args: readonly string[]): PurgeMode {
  if (args.length === 0) return "trash";
  if (args.length === 1 && args[0] === "--private-jobs-only") return "private-jobs";
  throw new Error("invalid purge command");
}
export async function executePurge(mode: PurgeMode, ports: {
  trash: () => Promise<{ pages: number; assetPaths: readonly string[] }>;
  privateJobs: () => Promise<readonly string[]>;
}): Promise<{ pages: number; assets: number; pendingObjects: number }> {
  const trash = mode === "trash" ? await ports.trash() : { pages: 0, assetPaths: [] };
  const pending = await ports.privateJobs();
  return { pages: trash.pages, assets: trash.assetPaths.length, pendingObjects: pending.length };
}
