"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  RecordingRequestError,
  addCandidate,
  adoptCandidate,
  deleteCandidate,
  getCandidate,
  recordingErrorMessage,
  retryCandidate,
  type RecordingCandidateFull,
  type RecordingCandidateSummary,
  type RecordingSnapshot,
} from "@/lib/recording-client";
import { canDiscloseTranscriptionEngine, candidateEngineLabel, transcriptionServiceNote } from "@/recording/candidate-names";
import { formatClock, speakerLabel } from "@/lib/recording-view";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: "6px 0 0", padding: 0 };
const PREVIEW_STYLE: CSSProperties = { margin: "6px 0 0", padding: "8px 10px", border: "1px solid var(--ed-line-2)", borderRadius: 10 };

type Message = { kind: "info" | "error"; text: string };

/** 作っている途中の案の状態を読み直す間隔（ミリ秒）。 */
const CANDIDATE_POLL_MS = 4000;

/** 案の状態の言葉（色だけで表さない）。 */
const STATE_LABELS: Readonly<Record<RecordingCandidateSummary["state"], string>> = {
  pending: "作っています",
  ready: "できました",
  failed: "できませんでした",
};

function detailOf(candidate: RecordingCandidateSummary): string {
  const parts = [STATE_LABELS[candidate.state]];
  if (candidate.segmentCount > 0) parts.push(`${candidate.segmentCount} 段落`);
  if (candidate.adopted) parts.push("採用中");
  return parts.join(" · ");
}

/**
 * 文字起こしの案（#36 段 3b-4）。同じ音声を別のエンジンで起こして**見比べ、採用する案を選ぶ**
 * （旧 NIHO docs の candidateSets の工程 1）。
 * - 「別の案を作る」で案を足し、その案の文字起こしを始める。使えるエンジンが 2 つ以上なら、どのエンジンで作るかを選べる
 *   （「Deepgram で案を作る」「Gemini で案を作る」）。1 つだけなら「別の案を作る」。
 * - 「見る」でその案の本文を読み、上の文字起こし（採用中の案）と見比べる。
 * - 「採用する」で正本に写す。それまでの本文（画面で直した分も）は、採用中だった案に残る。
 * - 要らなくなった案は「消す」（1 回確かめてから）。採用中の案と、作っている途中の案は消せない。
 * - 案がまだ 1 つも無い録音では、「別の案を作る」を押したときに、いまの文字起こしが 1 つ目の案になる。
 */
export function RecordingCandidates({
  pageId,
  candidates,
  engines,
  defaultEngine,
  onSnapshot,
  onChanged,
  disabled,
}: {
  pageId: string;
  candidates: readonly RecordingCandidateSummary[];
  /** いま使えるエンジン（2 つ以上あれば、どのエンジンで作るか選べる）。 */
  engines?: readonly string[];
  /** エンジン未指定で作る案が使う既定の送信先。 */
  defaultEngine?: string | null;
  /** 採用のあとの最新の録音（正本が入れ替わる）。 */
  onSnapshot: (snapshot: RecordingSnapshot) => void;
  /** 案が増えた・実行を積んだ（録音を読み直す）。 */
  onChanged: () => void;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<RecordingCandidateFull | null>(null);
  // 「消す」を押した案（1 回確かめる）
  const [confirming, setConfirming] = useState<string | null>(null);
  const locked = busy || disabled === true;
  const defaultCandidateEngine = (engines ?? []).length === 1 ? engines?.[0] ?? null : defaultEngine ?? null;

  // 案を作る・もう一度作る実行は、上の文字起こしの見張り（useTranscription）の対象ではない。作っている途中の案がある
  // あいだは、録音を読み直して状態を追う（できた・できなかったが画面に出る。読み直さないと「作っています」のまま残る）
  const building = candidates.some((candidate) => candidate.state === "pending");
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => changed.current(), CANDIDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [building]);

  const guard = async (action: "candidate" | "adopt" | "delete_candidate", job: () => Promise<Message | null>) => {
    if (locked) return;
    setBusy(true);
    try {
      setMessage(await job());
    } catch (error) {
      setMessage({ kind: "error", text: recordingErrorMessage(error, action) });
    } finally {
      setBusy(false);
    }
  };

  const create = (engine?: string) => {
    const recipient = engine ?? defaultCandidateEngine;
    if (!canDiscloseTranscriptionEngine(recipient)) {
      setMessage({ kind: "error", text: transcriptionServiceNote(recipient) });
      return;
    }
    return guard("candidate", async () => {
      const added = await addCandidate(pageId, engine);
      onChanged();
      if (added.started) return { kind: "info", text: `${added.candidate.name} の案を作っています` };
      // 案はできたが、実行を積めなかった（音声が途中・期限切れ・ほかの実行が走っている）
      return { kind: "error", text: recordingErrorMessage(new RecordingRequestError(409, added.cannotStart), "candidate") };
    });
  };

  const show = (candidate: RecordingCandidateSummary) =>
    guard("candidate", async () => {
      setShown(await getCandidate(pageId, candidate.id));
      return null;
    });

  const adopt = (candidate: RecordingCandidateSummary) =>
    guard("adopt", async () => {
      const next = await adoptCandidate(pageId, candidate.id);
      onSnapshot(next);
      setShown(null);
      return { kind: "info", text: `${candidate.name} を採用しました` };
    });

  const remove = (candidate: RecordingCandidateSummary) =>
    guard("delete_candidate", async () => {
      await deleteCandidate(pageId, candidate.id);
      setConfirming(null);
      if (shown?.id === candidate.id) setShown(null);
      onChanged();
      return { kind: "info", text: `${candidate.name} を消しました` };
    });

  const retry = (candidate: RecordingCandidateSummary) =>
    guard("candidate", async () => {
      await retryCandidate(pageId, candidate.id);
      onChanged();
      return { kind: "info", text: `${candidate.name} をもう一度作っています` };
    });

  return (
    <section aria-label="文字起こしの案" data-recording-candidates={candidates.length}>
      <div style={ROW_STYLE}>
        {/* エンジンが 2 つ以上使えるときは、どのエンジンで作るかを選ばせる（旧 NIHO docs の「別のエンジンの案」） */}
        {(engines ?? []).length > 1 ? (
          (engines ?? []).map((engine) => (
            <span key={engine} style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                className="es-btn es-btn--outline es-btn--sm"
                aria-disabled={locked || !canDiscloseTranscriptionEngine(engine) || undefined}
                onClick={() => void create(engine)}
              >
                {candidateEngineLabel(engine)} で案を作る
              </button>
              <span className="es-note">{transcriptionServiceNote(engine)}</span>
            </span>
          ))
        ) : (
          <>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={locked || !canDiscloseTranscriptionEngine(defaultCandidateEngine) || undefined} onClick={() => void create()}>
              別の案を作る
            </button>
            <span className="es-note">{transcriptionServiceNote(defaultCandidateEngine)}</span>
          </>
        )}
        <span className="es-note">同じ音声をもう一度文字起こしして、見比べて選べます</span>
      </div>
      {candidates.length > 0 && (
        <ul style={LIST_STYLE} aria-label="案の一覧">
          {candidates.map((candidate) => (
            <li key={candidate.id} style={ROW_STYLE} data-candidate={candidate.id} data-candidate-state={candidate.state}>
              <span className="es-note">
                {candidate.name}
                {candidate.engineLabel && candidate.engineLabel !== candidate.name ? `（${candidate.engineLabel}）` : ""} · {detailOf(candidate)}
              </span>
              <span className="es-sp" />
              {candidate.state === "ready" && (
                <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-disabled={locked || undefined} onClick={() => void show(candidate)}>
                  見る
                </button>
              )}
              {candidate.state === "ready" && !candidate.adopted && (
                <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={locked || undefined} onClick={() => void adopt(candidate)}>
                  採用する
                </button>
              )}
              {candidate.state === "failed" && (
                <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={locked || undefined} onClick={() => void retry(candidate)}>
                  もう一度
                </button>
              )}
              {/* 採用中・作っている途中は消せない（server も断る） */}
              {!candidate.adopted && candidate.state !== "pending" && confirming !== candidate.id && (
                <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-disabled={locked || undefined} onClick={() => setConfirming(candidate.id)}>
                  消す
                </button>
              )}
              {confirming === candidate.id && (
                <span role="group" aria-label="案を消す" style={ROW_STYLE}>
                  <span className="es-note">この案を消しますか</span>
                  <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={locked || undefined} onClick={() => void remove(candidate)}>
                    消す
                  </button>
                  <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => setConfirming(null)}>
                    やめる
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <div style={PREVIEW_STYLE} data-candidate-preview={shown.id}>
          <div style={ROW_STYLE}>
            <strong className="es-note">{shown.name}</strong>
            <span className="es-sp" />
            {!shown.adopted && (
              <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={locked || undefined} onClick={() => void adopt(shown)}>
                この案を採用する
              </button>
            )}
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => setShown(null)}>
              閉じる
            </button>
          </div>
          {shown.segments.map((segment, index) => (
            <p key={index} className="es-note">
              {segment.start !== null ? `[${formatClock(segment.start)}] ` : ""}
              {segment.speaker === null ? "" : `${speakerLabel(segment.speaker, shown.speakerNames[String(segment.speaker)])}: `}
              {segment.text}
            </p>
          ))}
        </div>
      )}
      {message?.kind === "info" && (
        <p role="status" aria-live="polite" className="es-note">
          {message.text}
        </p>
      )}
      {message?.kind === "error" && (
        <p role="alert" data-recording-candidates-error="">
          {message.text}
        </p>
      )}
    </section>
  );
}
