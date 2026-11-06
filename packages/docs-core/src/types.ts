import type { RunCloudProvenance } from "./runs.js";

/**
 * NIHO docs のデータの型（specs/initiatives/niho-docs.md §4.2）。
 * 工程＝名前と指示文だけ。工程 1（文字起こし／文章）は固定で `Flow.steps` に含めない。
 */

export type ProviderId = "claude" | "gpt" | "gemini";

export type Effort = "low" | "medium" | "high" | "max";

/**
 * 接続の方式（spec §2）。`subscription` はこの Mac でログイン済みの CLI（Claude Code・Codex CLI・Antigravity CLI）、`apiKey` は
 * 各社の API（鍵はこの Mac の app data。#18769）。全体で 1 つを選び、上限・失敗でも自動で切り替えない。
 */
export type Connection = "subscription" | "apiKey";

/**
 * 文字起こし（工程 1）のエンジン。`gemini` は今の方式の Gemini（サブスクリプションは Antigravity CLI、API キー方式は
 * Gemini API）、`this-mac` は この Mac の音声認識（niho-speech）、`deepgram` は Deepgram（API キー方式だけ）。
 * 並びは Gemini → この Mac → Deepgram（owner 2026-10-15）。
 */
export type TranscriptionEngine = "gemini" | "this-mac" | "deepgram";

/** 固有名詞の 4 列（表記・よみ・誤りやすい表記・補足）。文書ガイド（共通）と案件情報（案件ごと）が同じ形。 */
export type GlossaryEntry = {
  term: string;
  reading: string;
  variants: string[];
  note: string;
};

/** 工程 2 以降。`profile` はプロファイルの id（モデル × 思考量は設定が決める）。 */
export type Step = {
  id: string;
  name: string;
  instruction: string;
  provider?: ProviderId;
  profile: string;
  /**
   * 長い入力は区切って処理する（全文を書き直す段階。editor.niho.life の手順だけが使う。#277）。
   * 無ければ false。Mac アプリの工程の実行は見ない。
   */
  chunked?: boolean;
};

/**
 * お手本の文書（本文は `flows/samples/<flowId>/<sampleId>.txt`。取り込みで .md/.txt/.docx/.pdf から抽出した Markdown）。
 * `chars` は保存した本文の字数。長い文書は先頭だけを保存し、元の字数を `truncatedFrom` に持つ。
 */
export type FlowSample = { id: string; name: string; chars: number; truncatedFrom?: number; sourceUrl?: string };

export type Flow = {
  version: 1;
  id: string;
  name: string;
  /** 保存のたびに 1 つ増える。案件の snapshot に写す。 */
  revision: number;
  /** 文書ガイド（Markdown）。全工程の入力に入る。 */
  guide: string;
  /** 共通の固有名詞。 */
  terms: GlossaryEntry[];
  samples: FlowSample[];
  /**
   * 音声から文字起こしを行う工程を含むか。古い保存データの欠落は true として読む。
   * 新しく保存する工程設計と録音の snapshot は true/false を明示する。
   */
  transcription?: boolean;
  steps: Step[];
};

export type ProfileModel = { model: string; effort: Effort };

/** 案件の作成時に設定のプロファイルから解決した、工程のモデル（設定を変えても既存案件の再実行が再現できる）。 */
export type ResolvedStepModel = {
  provider: ProviderId;
  model: string;
  effort: Effort;
  profileId: string;
  /** 作成時のプロファイル名（表示用）。 */
  profileName: string;
  /**
   * 工程が指していた AI が登録されていなかったので、登録した AI の先頭へ寄せた（工程設計と実行の行で 1 行知らせる）。
   * 寄せた先は `provider`。
   */
  redirected?: boolean;
  /**
   * どの方式のプロファイルの表で解決したか（無い snapshot は S2a 以前＝サブスクリプション）。実行時の方式と違えば、同じ
   * プロファイル × 提供元を今の方式の表で解決し直す（provider が今の方式に登録されていなければ止める。別の AI に寄せない）。
   */
  connection?: Connection;
};

/** 案件が持つフローの写し（作成時の Flow ＋ 工程 id ごとの解決済みのモデル。revision は Flow の値）。 */
export type FlowSnapshot = Flow & { models: Record<string, ResolvedStepModel> };

/** モデルのプロファイル（標準・高性能・追加可）× 登録した AI → モデル × 思考量。 */
export type Profile = {
  id: string;
  name: string;
  models: Partial<Record<ProviderId, ProfileModel>>;
};

/** 話者人数（画面の「話者人数」。none は 1 人＝話者を分けない）。 */
export type SpeakerMode = "auto" | "2" | "3" | "4plus" | "none";

export type Language = "ja" | "en";

/** 案件に登場する人物。話者番号との対応は持たない。 */
export type ProjectEntity = {
  id: string;
  name: string;
  reading: string;
  role: string;
  note: string;
};

/**
 * 案件情報（固有名詞・背景情報）。話者人数・言語は録音ごと（P3 #18566）で、`speakers`・`language` は今の案件の root の録音と
 * P1 の案件だけが持つ（root の録音の値、P1 の録音の読み替えの元。新しい案件は持たない）。
 */
export type ProjectInfo = {
  speakers?: SpeakerMode;
  language?: Language;
  terms: GlossaryEntry[];
  background: string;
  /** 旧 project.json では欠落可。ユーザー所有の案件情報。 */
  entities?: ProjectEntity[];
};

/** 工程の入力の案件情報（録音の話者人数・言語 ＋ 案件の固有名詞・背景情報。pages.ts の recordingInfo）。 */
export type RecordingInfo = ProjectInfo & { speakers: SpeakerMode; language: Language };

/** 音声の写し（`inputs/<file>`）。 */
export type AudioInput = {
  /** inputs/ の中の写しのファイル名（乱数の id ＋ 拡張子）。 */
  file: string;
  /** 写しの SHA-256（16 進）。 */
  hash: string;
  /** 元のファイル名（表示用）。 */
  name: string;
  durationSec: number | null;
};

/** 取り込んだ文字起こし原本。本文は transcript.md、原本は inputs/<file> に別々に保持する。 */
export type TranscriptImportSource = {
  format: "vtt";
  /** inputs/ の中の原本の固定名。 */
  file: "source.vtt";
  /** 元のファイル名（表示用。話者名などの内容には使わない）。 */
  name: string;
  /** 原本 bytes の SHA-256（16 進）。 */
  hash: string;
};

/** 素材。音声のある録音か、文章／取り込んだ文字起こしを原文にした録音か。 */
export type ProjectSource =
  | { kind: "audio"; audio: AudioInput[] }
  | { kind: "text"; transcriptImport?: TranscriptImportSource };

/** ページの種類: 文書（白紙から書く）と録音（音声 → 工程 → 成果物の子ページ）。 */
export type PageKind = "doc" | "rec";

/** 保存形式のページ項目。ページIDは PageIndex.items のキーで、録音IDとは別に持つ。 */
export type StoredPageEntry = {
  kind: "document" | "recording";
  title: string;
  createdAt: string;
  recordingId?: string;
  derivation?: DerivedDocumentReceipt;
  /** 文書ページの移動世代（移動のたびに増える）。移動前の会話を閲覧だけにする（Recording.moveGeneration と同じ契約）。 */
  moveGeneration?: number;
};

/**
 * 原文から新しく作った文書の出典（#18681 の旧経路が書いた記録）。新しい文書は composer（#18722）が作り、この記録は書かない。
 * 既に作られたページの記録は、台帳を書き直すときも落とさずに残す。
 */
export type DerivedDocumentReceipt = {
  operationId: string;
  sourceProjectId: string | null;
  sourceKind: "artifact" | "document";
  sourcePageId: string;
  recordingId?: string;
  stepId?: string;
  candidateId?: string | null;
  artifactId?: string;
  version?: number;
  sourceHash: string;
  instructionHash: string;
  titleHash: string;
  outputHash: string;
};

/** 保存形式のページ台帳。order が唯一の表示順。 */
export type PageIndex = { version: 1; order: string[]; items: Record<string, StoredPageEntry> };

/** 画面と bridge で使うページ行（旧形式は読み込み時に同じ形へ正規化する）。 */
export type PageEntry = {
  id: string; kind: PageKind; title: string; createdAt: string; recordingId?: string; derivation?: DerivedDocumentReceipt;
  moveGeneration?: number;
};

/** フォルダ外のページ一覧（保存先直下の pages.json）。 */
export type RootPages = PageIndex;

/**
 * 録音のページ（`projects/<projectId>/recordings/<recId>/recording.json`）。今の案件の録音（予約 id `root`）は
 * project.json の flowSnapshot・source・info.speakers・info.language・legacy refs から作る（pages.ts の rootRecording）。
 */
export type Recording = {
  version: 1;
  id: string;
  /** ISO 8601 */
  createdAt: string;
  /** 作成時の Flow の写し。録音は常にこれを使う（フローを直しても自動で反映しない）。 */
  flowSnapshot: FlowSnapshot;
  source: ProjectSource;
  /** 話者人数（文字起こしと工程の案件情報に使う）。 */
  speakers: SpeakerMode;
  /** 言語（文字起こしと工程の案件情報に使う）。 */
  language: Language;
  /** 旧版の手動参考ページ id。新しい工程は同じフォルダの独立文書を実行時に自動で固定する。 */
  refs: string[];
  /** 移動のたびに増える。保存済み会話の session を移動先で resume しないための世代。 */
  moveGeneration?: number;
  /** 複数案対応工程の候補台帳。本文は artifactId が指す既存 artifacts/versions の正本にだけ置く。 */
  candidateSets?: Record<string, CandidateSet>;
  /**
   * 後工程に使う文字起こしの案（`candidateSets.source` の id。#19108）。無ければ最初の案（`transcript.md`）。台帳に無い id は
   * 別の案へ寄せず、後工程を止める（candidates.ts の selectedSourceCandidate）。
   */
  sourceCandidateId?: string;
};

/** 同じ成果物工程に属する対等な案。candidateId と工程ID・案名・本文H1は別物。 */
export type ArtifactCandidate = {
  id: string;
  /** artifacts/<artifactId>.md・versions/<artifactId>/ の内部キー。既存の最初の案だけ stepId と同じ。 */
  artifactId: string;
  name: string;
  createdAt: string;
  /** 共通素材から生成するときだけ足す案固有の指示。工程の指示文は変更しない。 */
  instruction?: string;
  /** 文字起こしの案（工程 1）だけ: 作ったエンジン（その実行だけに使い、設定の既定は変えない。#19108）。 */
  engine?: TranscriptionEngine;
  /** Gemini の案を作った接続方式。無い既存案はサブスクリプションとして扱う。 */
  engineConnection?: Connection;
};

export type CandidateSet = {
  stepId: string;
  order: string[];
  items: Record<string, ArtifactCandidate>;
};

/**
 * recording.json の中身（読んだまま）。P1 で作った録音は speakers・language・refs を持たないので、画面は pages.ts の
 * recordingOf で読み替えてから使う（ファイルは書き換えない。次の保存で整う）。
 */
export type RecordingFile = Omit<Recording, "speakers" | "language" | "refs"> &
  Partial<Pick<Recording, "speakers" | "language" | "refs">>;

/** `projects/<projectId>/project.json`。表示名はここだけに持つ（フォルダ名に使わない）。 */
export type Project = {
  version: 1;
  /** 短い乱数の id（フォルダ名）。 */
  id: string;
  name: string;
  /** ISO 8601 */
  createdAt: string;
  /**
   * root の録音（今の案件。案件フォルダ直下）の Flow の写し。今の案件だけが持つ（ページを持つ新しい案件は録音ごとに
   * recording.json に持つ）。
   */
  flowSnapshot?: FlowSnapshot;
  info: ProjectInfo;
  /** root の録音の素材（flowSnapshot と同じく今の案件だけ）。 */
  source?: ProjectSource;
  /** root 録音の旧版の手動参考ページ id（互換読み取り用。新しい工程の自動参考には使わない）。 */
  refs?: string[];
  /** root の録音の複数案台帳。本文は録音と同じ artifacts/versions に置く。 */
  candidateSets?: Record<string, CandidateSet>;
  /** root の録音の後工程に使う文字起こしの案（Recording.sourceCandidateId と同じ）。 */
  sourceCandidateId?: string;
  /** ページの一覧。無い（今の案件）なら root の録音 1 枚と読む（pages.ts の projectPages）。 */
  /** P6 以降は PageIndex。配列は P1〜P5 からの互換入力。 */
  pages?: PageIndex | PageEntry[];
};

/** 実行の前提（入力ごとのハッシュ）。前提が変わった工程に stale の印を出す。 */
export type Basis = {
  source: string;
  /** 工程 id → 成果物（最新版）のハッシュ。 */
  artifacts: Record<string, string>;
  info: string;
  guide: string;
  /**
   * この工程の指示文。工程設計を直して「この案件の工程を今の設計に更新」したとき、指示文が変わった工程に stale を出す。
   * 無い記録（S3 より前の版）は比べない。
   */
  step?: string;
  /**
   * 参考ページの材料（参考が無いときは空文字のハッシュ。plan.ts の refsHash）。無い記録（P3 より前）は「参考なし」と同じに
   * 比べる（参考を足したときだけ stale）。
   */
  refs?: string;
};

export type RunResult = "saved" | "failed" | "stopped";

/** 実行計画（spec §5.4）。v1 は `continuous`（分けずに渡し、続きで繋ぐ）。画面には出さない。 */
export type ExecutionPlan = "continuous" | "internalChunked";

/**
 * `runs.jsonl` の 1 行。`kind: "run"` は実行（文字起こしを含む）、`kind: "save"` は人の保存（版を足す）。
 * `kind: "agent"` は「AIと作る」の修正の会話（S5）: AI が書き換えた文書の版（`version` あり）と、依頼 1 回の記録
 * （`turnRecord: true`・`version` は null。使用量はこれだけを数える）。
 * 中央の「履歴」と 設定 › 使用量 がこれを読む。
 */
export type RunRecord = {
  id: string;
  kind: "run" | "save" | "agent";
  /** ISO 8601 */
  at: string;
  /** 工程 id。工程 1 は SOURCE_STEP_ID。 */
  stepId: string;
  stepName: string;
  /** 複数案の実行・保存・会話だけ。既存記録は無くても最初の案として読める。 */
  candidateId?: string;
  /** 実際に版と正本を書いた内部 artifact id。 */
  artifactId?: string;
  /** この記録で足した版の番号（失敗・停止は null）。 */
  version: number | null;
  result: RunResult;
  /** 文字起こしは エンジン（`this-mac`・`deepgram`、Gemini は `gemini`）。 */
  provider?: ProviderId | "this-mac" | "deepgram";
  /** 実行した方式（無い記録は S2a 以前＝サブスクリプション）。使用量は方式ごとに数え、API キー方式は見込み金額を出す。 */
  connection?: Connection;
  /** 依頼したモデル（snapshot の値）。 */
  model?: string;
  /** 実際に使ったモデル（CLI が返した値。返らなければ null）。 */
  modelUsed?: string | null;
  effort?: Effort;
  /** 実行時のプロファイル名。 */
  profile?: string;
  durationMs?: number;
  /** トークン数を提供元が返したか（返らなければ使用量は「取得できません」）。 */
  tokensKnown?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  costKnown?: boolean;
  /** 続きの回数。 */
  continuations?: number;
  /** 送った量（字数。参考ページを含む）。 */
  inputChars?: number;
  /** kind run: 入力に入れた参考ページ（文書のページの id と、送った本文の字数。参考の無い実行は持たない）。 */
  refs?: Array<{ pageId: string; chars: number }>;
  outputChars?: number;
  /** 版にしなかった途中までの出力の字数（checkpoint `runs/<runId>.json` にある）。 */
  partialChars?: number;
  /** 文字起こしした音声の長さ（秒）。 */
  audioSec?: number;
  /** Deepgram に渡した固有名詞（keyterm）の数（見込み金額の追加料金に使う）。 */
  keyterms?: number;
  reasonCode?: string;
  /** 失敗・停止の文言（履歴と会話の欄に出す）。 */
  message?: string;
  basis?: Basis;
  /** 実行開始時に固定した共有素材の版（source を含む）。 */
  inputVersions?: Record<string, number>;
  /** 履歴の古い版から戻したとき（「この版に戻す」）の元の版。 */
  restoredFrom?: number;
  /**
   * kind save: 利用者が操作せずに残した版（編集のまとまりの終わり・離れたとき・AI が書き換える直前・戻す直前・置き換える書き込みの
   * 前に今の内容を残したもの。auto-version.ts・spec niho-docs-cloud §8.2「版を残す時」）。
   */
  auto?: boolean;
  /** 工程 1 のこの版で使う話者番号 → 名前。Part がある本文はキーを `Part:番号` にする。 */
  transcriptSpeakerNames?: Record<string, string>;
  /** kind agent: 会話（conversations/<id>.json）と依頼の id。 */
  conversationId?: string;
  turnId?: string;
  /** kind agent: 人の指示の頭（履歴に「AIと作る「…」」として出す）。 */
  instruction?: string;
  /** kind agent: 依頼 1 回の記録（版の記録ではない）。 */
  turnRecord?: boolean;
} & RunCloudProvenance;

/**
 * 実行の checkpoint（`projects/<projectId>/runs/<runId>.json`。spec §5.4）。
 * 入力の fingerprint・途中までの出力・provider 固有の session ref・続きの回数・終了理由。
 * 停止・時間切れ・続きの上限・再開できないときの途中までの出力は、版にせずここに残す。
 */
export type RunCheckpoint = {
  schemaVersion: 1;
  runId: string;
  stepId: string;
  stepName: string;
  candidateId?: string;
  artifactId?: string;
  /** ISO 8601 */
  startedAt: string;
  updatedAt: string;
  plan: ExecutionPlan;
  /** 入力の fingerprint（前提のハッシュとプロンプトのハッシュ。文字起こしは null）。 */
  fingerprint: { basis: Basis; prompt: string } | null;
  provider: ProviderId | "this-mac" | "deepgram";
  model: string;
  effort: Effort | null;
  /** provider 固有の会話の ref（Claude Code の session id）。 */
  sessionRef: string | null;
  continuations: number;
  /** 結合済みの途中までの出力。 */
  output: string;
  /** 前の出力に繋げられなかった続き（自動で結合しない）。 */
  pending: string | null;
  state: "running" | "completed" | "stopped" | "failed";
  /** 終わった理由（StopReason・ReasonCode・アプリの理由）。 */
  endReason: string | null;
};
