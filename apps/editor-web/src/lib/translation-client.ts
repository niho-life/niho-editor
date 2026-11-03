import type { PageLang } from "@niho/editor-store";

export type TranslationFieldDto = { path: string; text: string };
export type TranslationRelationDto = {
  relationId: string;
  sourcePageId: string | null;
  targetPageId: string;
  sourceRevision: number | null;
  targetRevision: number;
  reviewedSourceRevision: number | null;
  reviewedTargetRevision: number | null;
  sourceMissing: boolean;
  detached: boolean;
};
export type TranslationProposalDto = {
  id: string;
  status: "generating" | "ready" | "failed" | "adopted" | "expired";
  generation: number;
  sourceRevision: number;
  targetRevision: number | null;
  targetPageId: string;
  expiresAt: string;
  omissions: string[];
  sourceFields?: TranslationFieldDto[];
  candidateFields?: TranslationFieldDto[];
};
export type TranslationStateDto = {
  page: { id: string; lang: PageLang; revision: number };
  relation: TranslationRelationDto | null;
  proposal: TranslationProposalDto | null;
  provider: { destination: "Anthropic API"; metered: true };
};

export class TranslationRequestError extends Error {
  override readonly name = "TranslationRequestError";
  constructor(readonly status: number, readonly code: string | null) {
    super(`translation request failed with ${status}`);
  }
}

async function failure(response: Response): Promise<TranslationRequestError> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new TranslationRequestError(response.status, typeof body?.error === "string" ? body.error : null);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) throw await failure(response);
  return response.json();
}

function pagePath(pageId: string, suffix = ""): string {
  return `/api/pages/${encodeURIComponent(pageId)}/translation${suffix}`;
}

export async function loadTranslation(pageId: string): Promise<TranslationStateDto> {
  return await request(pagePath(pageId)) as TranslationStateDto;
}

export async function generateTranslation(pageId: string, operationId: string): Promise<TranslationProposalDto> {
  const value = await request(pagePath(pageId, "/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId }),
  }) as { proposal?: TranslationProposalDto };
  if (!value.proposal) throw new TranslationRequestError(500, "invalid_response");
  return value.proposal;
}

export async function adoptTranslation(pageId: string, proposal: TranslationProposalDto): Promise<{ targetPageId: string }> {
  const value = await request(pagePath(pageId, `/proposals/${encodeURIComponent(proposal.id)}/adopt`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceRevision: proposal.sourceRevision, targetRevision: proposal.targetRevision }),
  }) as { targetPageId?: unknown };
  if (typeof value.targetPageId !== "string") throw new TranslationRequestError(500, "invalid_response");
  return { targetPageId: value.targetPageId };
}

export async function reviewTranslation(pageId: string, sourceRevision: number, targetRevision: number): Promise<void> {
  await request(pagePath(pageId, "/review"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceRevision, targetRevision }),
  });
}

export async function detachTranslation(pageId: string, targetRevision: number): Promise<void> {
  await request(pagePath(pageId, "/detach"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetRevision }),
  });
}
