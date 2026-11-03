export type StepEffort = "low" | "medium" | "high";
export type StepGenerationOptions = {
  maxTokens: number;
  thinking?: { type: "adaptive" };
  outputConfig?: { effort: StepEffort };
};

const PROFILE_LIMITS: Readonly<Record<string, number>> = {
  light: 32_000,
  standard: 12_000,
  advanced: 20_000,
};

const PROFILE_EFFORTS: Readonly<Record<string, StepEffort>> = {
  light: "low",
  standard: "medium",
  advanced: "high",
};

/** Adaptive thinking と effort を受け付ける既知の Claude API model ID。 */
export function supportsAdaptiveEffort(model: string): boolean {
  return /^claude-(?:sonnet|opus)-(?:5(?:-\d+)?|4-(?:6|7|8))(?:-|$)/i.test(model);
}

/**
 * run 開始時に固定された工程 profile を Messages API の生成条件へ訳す。
 * 未知 profile は標準として扱い、常にサーバー設定と既存の上限の小さい方に収める。
 */
export function stepGenerationOptions(
  model: string,
  profile: string | undefined,
  requestedMaxTokens: number,
  serverLimit: number,
): StepGenerationOptions {
  const knownProfile = profile && profile in PROFILE_LIMITS ? profile : "standard";
  const profileLimit = PROFILE_LIMITS[knownProfile]!;
  const safeServerLimit = Number.isFinite(serverLimit) ? Math.max(1, Math.floor(serverLimit)) : 12_000;
  const safeRequested = Number.isFinite(requestedMaxTokens) ? Math.max(1, Math.floor(requestedMaxTokens)) : safeServerLimit;
  const result: StepGenerationOptions = {
    maxTokens: Math.min(safeRequested, safeServerLimit, profileLimit),
  };
  if (supportsAdaptiveEffort(model)) {
    result.thinking = { type: "adaptive" };
    result.outputConfig = { effort: PROFILE_EFFORTS[knownProfile]! };
  }
  return result;
}
