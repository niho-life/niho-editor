"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  RecordingCandidateConflictError,
  RecordingConflictError,
  RecordingRequestError,
  addCandidate,
  adoptCandidate,
  deleteCandidate,
  getCandidate,
  getCandidateVersion,
  listCandidateVersions,
  recordingErrorMessage,
  restoreCandidateVersion,
  retryCandidate,
  updateCandidate,
  type RecordingCandidateFull,
  type RecordingCandidateSummary,
  type RecordingCandidateVersion,
  type RecordingCandidateVersionSummary,
  type RecordingSnapshot,
} from "@/lib/recording-client";
import { canDiscloseTranscriptionEngine, candidateEngineLabel, transcriptionServiceNote } from "@/recording/candidate-names";
import { formatClock, speakerLabel } from "@/lib/recording-view";
import { MacGeminiTranscription } from "./MacGeminiTranscription";
import styles from "./RecordingCandidates.module.css";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: "6px 0 0", padding: 0 };
type Message = { kind: "info" | "error"; text: string };
type CandidateDraft = {
  base: RecordingCandidateFull;
  name: string;
  segments: RecordingCandidateFull["segments"];
  speakerNames: Record<string, string>;
  dirty: boolean;
  held: boolean;
  conflict?: RecordingCandidateFull;
};

const CANDIDATE_POLL_MS = 4000;
const STATE_LABELS: Readonly<Record<RecordingCandidateSummary["state"], string>> = {
  pending: "作っています",
  ready: "できました",
  failed: "できませんでした",
};
const VERSION_REASON: Readonly<Record<RecordingCandidateVersionSummary["reason"], string>> = {
  initial: "初期版",
  edit: "編集",
  recording: "採用中本文の編集",
  asr: "文字起こし結果",
  restore: "復元",
};

function detailOf(candidate: RecordingCandidateSummary): string {
  const parts = [STATE_LABELS[candidate.state], `版 ${candidate.revision}`];
  if (candidate.segmentCount > 0) parts.push(`${candidate.segmentCount} 段落`);
  if (candidate.adopted) parts.push("採用中");
  if (candidate.busy) parts.push("生成中は変更できません");
  return parts.join(" · ");
}

function retryEngineOf(candidate: RecordingCandidateSummary, engines: readonly string[] | undefined, defaultEngine: string | null | undefined): string | null {
  return candidate.engine !== null && (engines ?? []).includes(candidate.engine) ? candidate.engine : defaultEngine ?? null;
}

function draftOf(candidate: RecordingCandidateFull): CandidateDraft {
  return {
    base: candidate,
    name: candidate.name,
    segments: candidate.segments.map((segment) => ({ ...segment })),
    speakerNames: { ...candidate.speakerNames },
    dirty: false,
    held: false,
  };
}

function usedSpeakers(candidate: Pick<CandidateDraft, "segments">): number[] {
  return [...new Set(candidate.segments.flatMap((segment) => (segment.speaker === null ? [] : [segment.speaker])))].sort((a, b) => a - b);
}

function CandidatePane({
  draft, adoptedContent, history, historyPreview, locked, adoptLocked, canSeek, mobileHidden,
  onChange, onSave, onAdopt, onReload, onHistory, onPreviewVersion, onRestore, onSeek,
}: {
  draft: CandidateDraft;
  adoptedContent?: Pick<RecordingCandidateFull, "segments" | "speakerNames">;
  history: readonly RecordingCandidateVersionSummary[] | null | undefined;
  historyPreview: RecordingCandidateVersion | null | undefined;
  locked: boolean;
  adoptLocked: boolean;
  canSeek: boolean;
  mobileHidden: boolean;
  onChange: (next: CandidateDraft) => void;
  onSave: () => void;
  onAdopt: () => void;
  onReload: () => void;
  onHistory: () => void;
  onPreviewVersion: (version: number) => void;
  onRestore: (version: number) => void;
  onSeek?: (seconds: number) => void;
}) {
  const bodyEditable = !draft.base.adopted;
  const shownSegments = draft.base.adopted && adoptedContent ? adoptedContent.segments : draft.segments;
  const shownSpeakerNames = draft.base.adopted && adoptedContent ? adoptedContent.speakerNames : draft.speakerNames;
  const speakers = usedSpeakers({ segments: shownSegments });
  return (
    <article className={styles.panel} data-mobile-hidden={mobileHidden || undefined} data-candidate-editor={draft.base.id}>
      <div style={ROW_STYLE}>
        <label className={styles.nameField}>
          <span>案の名前</span>
          <input value={draft.name} disabled={locked} maxLength={60} onChange={(event) => onChange({ ...draft, name: event.currentTarget.value, dirty: true })} />
        </label>
        <span className="es-note">{draft.base.adopted ? "採用中（本文は上の文字起こしで編集）" : `版 ${draft.base.revision}`}</span>
      </div>
      {draft.held && <p role="alert">別の場所で先に直されました。入力は残しています。最新の内容を確認するか、下書きを破棄して読み直してください。</p>}
      {draft.conflict && <div className={styles.versionPreview} aria-label="別の場所で保存された内容">
        <strong>{`版 ${draft.conflict.revision}: ${draft.conflict.name}`}</strong>
        {draft.conflict.segments.map((segment, index) => <p key={index}>
          {segment.speaker === null ? "" : `${speakerLabel(segment.speaker, draft.conflict!.speakerNames[String(segment.speaker)])}: `}{segment.text}
        </p>)}
        <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked} onClick={() => onChange({ ...draft, base: draft.conflict!, held: false, conflict: undefined })}>最新を確認したので、この入力を使う</button>
      </div>}
      {!canSeek && <p className="es-note">音声は期限切れ・取り込み中・欠落のため移動できません。テキストの比較と編集は続けられます。</p>}
      {speakers.length > 0 && (
        <fieldset className={styles.speakers} disabled={locked || !bodyEditable}>
          <legend>話者名</legend>
          {speakers.map((speaker) => (
            <label key={speaker}>
              <span>{`話者${speaker}`}</span>
              <input
                value={shownSpeakerNames[String(speaker)] ?? ""}
                maxLength={60}
                placeholder={`話者${speaker}`}
                onChange={(event) => {
                  const speakerNames = { ...draft.speakerNames };
                  const name = event.currentTarget.value;
                  if (name) speakerNames[String(speaker)] = name;
                  else delete speakerNames[String(speaker)];
                  onChange({ ...draft, speakerNames, dirty: true });
                }}
              />
            </label>
          ))}
        </fieldset>
      )}
      <div className={styles.segments} aria-label={`${draft.name} の本文`}>
        {shownSegments.map((segment, index) => (
          <div key={index} className={styles.segment}>
            <div className={styles.segmentMeta}>
              {segment.start !== null ? (
                <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={!canSeek} onClick={() => onSeek?.(segment.start!)} aria-label={`${formatClock(segment.start)}へ移動`}>
                  {formatClock(segment.start)}
                </button>
              ) : <span>時刻なし</span>}
              {segment.speaker !== null && <span>{speakerLabel(segment.speaker, shownSpeakerNames[String(segment.speaker)])}</span>}
            </div>
            <textarea
              aria-label={`${draft.name} の段落 ${index + 1}`}
              value={segment.text}
              readOnly={!bodyEditable}
              disabled={locked}
              onChange={(event) => {
                const segments = draft.segments.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.currentTarget.value } : item);
                onChange({ ...draft, segments, dirty: true });
              }}
            />
          </div>
        ))}
      </div>
      <div style={ROW_STYLE}>
        <button type="button" className="es-btn niho-primary-surface es-btn--sm" disabled={locked || !draft.dirty || draft.held} onClick={onSave}>変更を保存</button>
        {!draft.base.adopted && <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked || adoptLocked || draft.dirty || draft.held} onClick={onAdopt}>この案を採用</button>}
        {draft.dirty && <span className="es-note">未保存の変更があります。採用する前に保存してください。</span>}
        {draft.held && <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={locked} onClick={onReload}>下書きを破棄して最新を読み直す</button>}
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={locked} onClick={onHistory}>履歴</button>
      </div>
      {history === null && <p role="status">履歴を読み込んでいます</p>}
      {history && (
        <ol className={styles.history} aria-label={`${draft.name} の履歴`}>
          {history.map((version) => (
            <li key={version.version}>
              <span>{`版 ${version.version} · ${VERSION_REASON[version.reason]} · ${new Date(version.createdAt).toLocaleString("ja-JP")}`}</span>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => onPreviewVersion(version.version)}>この版を見る</button>
              {!draft.base.adopted && version.version !== draft.base.revision && (
                <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked || draft.dirty} onClick={() => onRestore(version.version)}>この版を復元</button>
              )}
            </li>
          ))}
        </ol>
      )}
      {historyPreview && (
        <div className={styles.versionPreview} aria-label={`版 ${historyPreview.version} の内容`}>
          <strong>{`版 ${historyPreview.version}: ${historyPreview.name}`}</strong>
          {historyPreview.segments.map((segment, index) => (
            <p key={index}>
              {segment.start === null ? "" : `[${formatClock(segment.start)}] `}
              {segment.speaker === null ? "" : `${speakerLabel(segment.speaker, historyPreview.speakerNames[String(segment.speaker)])}: `}
              {segment.text}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

/** 同じ録音の独立候補を任意の 2 案で比較し、明示保存・復元・採用する。 */
export function RecordingCandidates({
  pageId, recordingRevision, adoptedContent, candidates, engines, defaultEngine, onSnapshot, onConflictSnapshot, onChanged, onSeek, onAdoptingChange, adoptDisabled, disabled,
}: {
  pageId: string;
  recordingRevision: number;
  adoptedContent?: Pick<RecordingCandidateFull, "segments" | "speakerNames">;
  candidates: readonly RecordingCandidateSummary[];
  engines?: readonly string[];
  defaultEngine?: string | null;
  onSnapshot: (snapshot: RecordingSnapshot) => void;
  onConflictSnapshot?: (snapshot: RecordingSnapshot) => void;
  onChanged: () => void;
  onSeek?: (seconds: number) => void;
  onAdoptingChange?: (adopting: boolean) => void;
  adoptDisabled?: boolean;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});
  const [slotA, setSlotA] = useState<string | null>(null);
  const [slotB, setSlotB] = useState<string | null>(null);
  const [mobileSlot, setMobileSlot] = useState<"a" | "b">("a");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [histories, setHistories] = useState<Record<string, readonly RecordingCandidateVersionSummary[] | null>>({});
  const [historyPreviews, setHistoryPreviews] = useState<Record<string, RecordingCandidateVersion | null>>({});
  const pageBusy = candidates.some((candidate) => candidate.busy);
  const locked = busy || disabled === true || pageBusy;
  const defaultCandidateEngine = (engines ?? []).length === 1 ? engines?.[0] ?? null : defaultEngine ?? null;
  const ready = useMemo(() => candidates.filter((candidate) => candidate.state === "ready"), [candidates]);

  const building = candidates.some((candidate) => candidate.state === "pending");
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; });
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => changed.current(), CANDIDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [building]);

  const hasUnsavedCandidate = Object.values(drafts).some((draft) => draft.dirty);
  useEffect(() => {
    if (!hasUnsavedCandidate) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedCandidate]);

  const guard = useCallback(async (action: "candidate" | "adopt" | "delete_candidate", job: () => Promise<Message | null>) => {
    if (busy || disabled) return;
    setBusy(true);
    try { setMessage(await job()); }
    catch (error) { setMessage({ kind: "error", text: recordingErrorMessage(error, action) }); }
    finally { setBusy(false); }
  }, [busy, disabled]);

  const load = useCallback(async (candidateId: string) => {
    if (drafts[candidateId]) return;
    const candidate = await getCandidate(pageId, candidateId);
    setDrafts((current) => current[candidateId] ? current : { ...current, [candidateId]: draftOf(candidate) });
  }, [drafts, pageId]);

  const choose = (slot: "a" | "b", candidateId: string) => {
    if (slot === "a") { setSlotA(candidateId || null); if (candidateId && candidateId === slotB) setSlotB(null); }
    else { setSlotB(candidateId || null); if (candidateId && candidateId === slotA) setSlotA(null); }
    if (candidateId) void guard("candidate", async () => { await load(candidateId); return null; });
  };

  const create = (engine?: string) => {
    const recipient = engine ?? defaultCandidateEngine;
    if (!canDiscloseTranscriptionEngine(recipient)) { setMessage({ kind: "error", text: transcriptionServiceNote(recipient) }); return; }
    void guard("candidate", async () => {
      const added = await addCandidate(pageId, engine);
      onChanged();
      return added.started
        ? { kind: "info", text: `${added.candidate.name} の案を作っています` }
        : { kind: "error", text: recordingErrorMessage(new RecordingRequestError(409, added.cannotStart), "candidate") };
    });
  };

  const save = (candidateId: string) => void guard("candidate", async () => {
    const draft = drafts[candidateId];
    if (!draft) return null;
    if (draft.held) return { kind: "error", text: "最新の内容を確認してから保存してください。入力は残しています。" };
    try {
      const saved = await updateCandidate(pageId, candidateId, draft.base.adopted
        ? { expectedRevision: draft.base.revision, name: draft.name }
        : { expectedRevision: draft.base.revision, name: draft.name, segments: draft.segments, speakerNames: draft.speakerNames });
      setDrafts((current) => ({ ...current, [candidateId]: draftOf(saved) }));
      onChanged();
      return { kind: "info", text: `${saved.name} を保存しました` };
    } catch (error) {
      if (error instanceof RecordingCandidateConflictError) {
        setDrafts((current) => ({ ...current, [candidateId]: { ...draft, conflict: error.candidate, held: true, dirty: true } }));
        return { kind: "error", text: "別の場所で先に直されました。入力は残しています。確認してもう一度保存してください。" };
      }
      throw error;
    }
  });

  const reload = (candidateId: string) => void guard("candidate", async () => {
    const latest = await getCandidate(pageId, candidateId);
    setDrafts((current) => ({ ...current, [candidateId]: draftOf(latest) }));
    return { kind: "info", text: `${latest.name} の最新内容を読み直しました` };
  });

  const adopt = (candidateId: string) => void guard("adopt", async () => {
    const draft = drafts[candidateId];
    const summary = candidates.find((candidate) => candidate.id === candidateId);
    if (!draft && !summary) return null;
    if (adoptDisabled) return { kind: "error", text: "上の文字起こしに未保存の変更があります。先に保存してください。" };
    if (draft?.dirty) return { kind: "error", text: "未保存の変更を保存してから採用してください。" };
    if (draft?.held) return { kind: "error", text: "候補の最新内容を読み直してから採用してください。" };
    onAdoptingChange?.(true);
    try {
      const next = await adoptCandidate(pageId, candidateId, draft?.base.revision ?? summary!.revision, recordingRevision);
      onSnapshot(next);
      setDrafts((current) => { const copy = { ...current }; delete copy[candidateId]; return copy; });
      return { kind: "info", text: `${draft?.name ?? summary!.name} を採用しました` };
    } catch (error) {
      if (error instanceof RecordingConflictError) {
        onConflictSnapshot?.(error.snapshot);
        const latest = error.snapshot.candidates?.find((candidate) => candidate.id === candidateId);
        if (draft && latest && latest.revision !== draft.base.revision) {
          setDrafts((current) => ({ ...current, [candidateId]: { ...draft, held: true } }));
          return { kind: "error", text: "別の場所で案が先に変わりました。表示は残しています。最新を読み直してから採用してください。" };
        }
        return { kind: "error", text: "別の場所で録音が先に変わりました。最新に合わせたので、内容を確認してもう一度採用してください。" };
      }
      throw error;
    } finally {
      onAdoptingChange?.(false);
    }
  });

  const showHistory = (candidateId: string) => void guard("candidate", async () => {
    setHistories((current) => ({ ...current, [candidateId]: null }));
    const versions = await listCandidateVersions(pageId, candidateId);
    setHistories((current) => ({ ...current, [candidateId]: versions }));
    return null;
  });
  const previewVersion = (candidateId: string, version: number) => void guard("candidate", async () => {
    const found = await getCandidateVersion(pageId, candidateId, version);
    setHistoryPreviews((current) => ({ ...current, [candidateId]: found }));
    return null;
  });
  const restore = (candidateId: string, version: number) => void guard("candidate", async () => {
    const draft = drafts[candidateId];
    if (!draft) return null;
    try {
      const restored = await restoreCandidateVersion(pageId, candidateId, version, draft.base.revision);
      setDrafts((current) => ({ ...current, [candidateId]: draftOf(restored) }));
      setHistories((current) => { const copy = { ...current }; delete copy[candidateId]; return copy; });
      onChanged();
      return { kind: "info", text: `版 ${version} を新しい版として復元しました` };
    } catch (error) {
      if (error instanceof RecordingCandidateConflictError) {
        setDrafts((current) => ({ ...current, [candidateId]: { ...draft, conflict: error.candidate, held: true, dirty: true } }));
        return { kind: "error", text: "別の場所で先に直されました。入力は残しています。" };
      }
      throw error;
    }
  });

  const remove = (candidate: RecordingCandidateSummary) => void guard("delete_candidate", async () => {
    await deleteCandidate(pageId, candidate.id);
    setConfirming(null);
    setDrafts((current) => { const copy = { ...current }; delete copy[candidate.id]; return copy; });
    if (slotA === candidate.id) setSlotA(null);
    if (slotB === candidate.id) setSlotB(null);
    onChanged();
    return { kind: "info", text: `${candidate.name} を消しました` };
  });

  const retry = (candidate: RecordingCandidateSummary) => {
    const engine = retryEngineOf(candidate, engines, defaultEngine);
    if (!canDiscloseTranscriptionEngine(engine)) { setMessage({ kind: "error", text: transcriptionServiceNote(engine) }); return; }
    void guard("candidate", async () => { await retryCandidate(pageId, candidate.id); onChanged(); return { kind: "info", text: `${candidate.name} をもう一度作っています` }; });
  };

  const setDraft = (id: string, draft: CandidateDraft) => setDrafts((current) => ({ ...current, [id]: draft }));
  const slots = [{ key: "a" as const, id: slotA }, { key: "b" as const, id: slotB }];

  return (
    <section className={styles.root} aria-label="文字起こしの案" data-recording-candidates={candidates.length}>
      <div style={ROW_STYLE}>
        {(engines ?? []).length > 1 ? (engines ?? []).map((engine) => (
          <span key={engine} style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked || !canDiscloseTranscriptionEngine(engine)} onClick={() => create(engine)}>{candidateEngineLabel(engine)} で案を作る</button>
            <span className="es-note">{transcriptionServiceNote(engine)}</span>
          </span>
        )) : <>
          <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked || !canDiscloseTranscriptionEngine(defaultCandidateEngine)} onClick={() => create()}>別の案を作る</button>
          <span className="es-note">{transcriptionServiceNote(defaultCandidateEngine)}</span>
        </>}
        <span className="es-note">閲覧や比較では採用されません。「採用」で選んだ本文だけが後続工程に入ります。</span>
      </div>
      <MacGeminiTranscription pageId={pageId} hasTranscript disabled={locked} onSucceeded={onChanged} />
      {candidates.length > 0 && <ul style={LIST_STYLE} aria-label="案の一覧">
        {candidates.map((candidate) => <li key={candidate.id} style={ROW_STYLE} data-candidate={candidate.id} data-candidate-state={candidate.state}>
          <span className="es-note">{candidate.name}{candidate.engineLabel && candidate.engineLabel !== candidate.name ? `（${candidate.engineLabel}）` : ""} · {detailOf(candidate)}</span>
          <span className="es-sp" />
          {candidate.state === "ready" && <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={locked} onClick={() => choose("a", candidate.id)}>見る・編集</button>}
          {candidate.state === "ready" && !candidate.adopted && <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked || adoptDisabled} onClick={() => adopt(candidate.id)}>採用する</button>}
          {candidate.state === "failed" && <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked || !canDiscloseTranscriptionEngine(retryEngineOf(candidate, engines, defaultEngine))} onClick={() => retry(candidate)}>もう一度</button>}
          {!candidate.adopted && candidate.state !== "pending" && confirming !== candidate.id && <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={locked} onClick={() => setConfirming(candidate.id)}>消す</button>}
          {confirming === candidate.id && <span role="group" aria-label="案を消す" style={ROW_STYLE}><span className="es-note">この案を消しますか</span><button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={locked} onClick={() => remove(candidate)}>消す</button><button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => setConfirming(null)}>やめる</button></span>}
        </li>)}
      </ul>}
      {ready.length > 0 && <div className={styles.compareControls}>
        <label>比較する案 1<select aria-label="比較する案1" value={slotA ?? ""} onChange={(event) => choose("a", event.currentTarget.value)}><option value="">選択</option>{ready.filter((item) => item.id !== slotB).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>比較する案 2<select aria-label="比較する案2" value={slotB ?? ""} onChange={(event) => choose("b", event.currentTarget.value)}><option value="">選択</option>{ready.filter((item) => item.id !== slotA).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {slotA && slotB && <span className={styles.mobileSwitch}><button type="button" aria-pressed={mobileSlot === "a"} onClick={() => setMobileSlot("a")}>案 1</button><button type="button" aria-pressed={mobileSlot === "b"} onClick={() => setMobileSlot("b")}>案 2</button></span>}
      </div>}
      <div className={styles.comparison} data-comparison-count={slots.filter((slot) => slot.id).length}>
        {slots.map((slot) => {
          const draft = slot.id ? drafts[slot.id] : undefined;
          return draft ? <CandidatePane
            key={slot.key} draft={draft} adoptedContent={adoptedContent} history={histories[draft.base.id]} historyPreview={historyPreviews[draft.base.id]}
            locked={locked} adoptLocked={adoptDisabled === true} canSeek={onSeek !== undefined} mobileHidden={slotA !== null && slotB !== null && mobileSlot !== slot.key}
            onChange={(next) => setDraft(draft.base.id, next)} onSave={() => save(draft.base.id)} onAdopt={() => adopt(draft.base.id)} onReload={() => reload(draft.base.id)}
            onHistory={() => showHistory(draft.base.id)} onPreviewVersion={(version) => previewVersion(draft.base.id, version)}
            onRestore={(version) => restore(draft.base.id, version)} onSeek={onSeek}
          /> : null;
        })}
      </div>
      {pageBusy && <p role="status">文字起こしを生成中です。完了するまで編集・復元・採用はできません。</p>}
      {message?.kind === "info" && <p role="status" aria-live="polite" className="es-note">{message.text}</p>}
      {message?.kind === "error" && <p role="alert" data-recording-candidates-error="">{message.text}</p>}
    </section>
  );
}
