import { tabLabel, type FlowTab, type FlowView, type StepStatus, type TabLocation } from "@niho/editor-store";
import type { RecipeDef } from "../steps/recipes";
import type { RunView } from "./steps-api";

/**
 * 「ページ」パネルの「流れ」の行（#309。純粋な計算。通信・DB は持たない）。
 *
 * 行は 録音 › 文字起こし › 手順の段階…。各行に、その役割の入れ物（あれば）とタブ、今開いているタブの行の印、
 * 右端の「作成」「済み」。「作成」は今開いているタブを入力にその段階までを作る（間の段階が無ければ一緒に）。
 * 「済み」はその段階の入れ物に、今のタブから系譜（`made_from.input` を最大 8 段たどる）で作られたタブがあるとき。
 * 文字起こしの行（#310）は役割 transcript の入れ物とそのタブ。録音のタブか文字起こしのタブを開いているときはエンジンのメニュー
 * （`recording` の録音で済んだエンジンは「済み」）。録音のタブからは段階を作らない（段階の入力は文字起こしのタブ）。
 */
export type FlowRowView = {
  kind: "rec" | "transcript" | "step";
  /** 段階の行だけ。 */
  stepId?: string;
  stepIndex?: number;
  /** 行の名前（入れ物があればその名前、無ければ役割の名前）。 */
  name: string;
  holder: { id: string; title: string } | null;
  tabs: { id: string; kind: FlowTab["kind"]; label: string; status: StepStatus | null; running: boolean; /** 段階の出力（`made_from.kind = 'step'`）。 */ generated: boolean }[];
  /** 今開いているタブがこの入れ物のもの。 */
  current: boolean;
  /** 今の行だけ: 開いているタブが何から作られたか（「記事方針 2」。入力の無いタブ・系譜の外は null）。 */
  from: string | null;
  action: "go" | "done" | null;
  /** 文字起こしの行で、録音のタブか文字起こしのタブを開いているときだけ。 */
  engines?: { id: string; used: boolean }[];
  /** 文字起こしの行で engines があるとき: エンジンのメニューが文字起こしする録音のタブ。 */
  recording?: string;
};

/** 役割の無い入れ物の 1 つ目のタブの札（入れ物の名前と、タブが 2 つ以上ならその札）。 */
function fullLabel(holders: readonly FlowView["holders"][number][], tab: FlowTab): string {
  const holder = holders.find((item) => item.tabs.some((candidate) => candidate.id === tab.id));
  if (!holder) return tab.title;
  const name = holder.title || "無題";
  return holder.tabs.length > 1 ? `${name} ${tabLabel({ tabName: tab.tabName, tabPos: tab.tabPos })}` : name;
}

/** `tab` が `source` から系譜（`made_from.input`）で作られたか（最大 8 段）。 */
function derivedFrom(tabsById: ReadonlyMap<string, FlowTab>, tab: FlowTab, sourceId: string): boolean {
  let current: FlowTab | undefined = tab;
  for (let hops = 0; current && hops < 8; hops++) {
    const made = current.madeFrom;
    if (!made || made.kind !== "step") return false;
    if (made.input === sourceId) return true;
    current = tabsById.get(made.input);
  }
  return false;
}

export function flowRows(input: {
  tab: TabLocation;
  flow: FlowView | null;
  recipe: Pick<RecipeDef, "id" | "steps">;
  run: RunView | null;
  /** いま使える文字起こしのエンジン。 */
  engines: readonly string[];
}): FlowRowView[] {
  const holders = input.flow?.holders ?? [];
  const tabsById = new Map(holders.flatMap((holder) => holder.tabs.map((tab) => [tab.id, tab] as const)));
  const runningIds = new Set(input.run && (input.run.state === "queued" || input.run.state === "running")
    ? input.run.steps.filter((step) => step.state === "queued" || step.state === "running" || step.state === "pending").map((step) => step.pageId)
    : []);
  const current = holders.find((holder) => holder.tabs.some((tab) => tab.id === input.tab.id)) ?? null;
  const currentTab = current?.tabs.find((tab) => tab.id === input.tab.id) ?? null;
  const currentRole = current?.role ?? null;
  const stepIndexOf = (stepId: string) => input.recipe.steps.findIndex((step) => step.id === stepId);
  // 今のタブの位置: 録音 → -1、段階 k の入れ物のタブ → k、文字起こし・役割の無い・別の手順の役割 → 文字起こしの位置（段階の入力になれる）
  const pos = input.tab.kind === "rec" ? -1 : currentRole?.kind === "step" && currentRole.recipe === input.recipe.id ? stepIndexOf(currentRole.stepId) : -0.5;
  const made = currentTab?.madeFrom;
  const fromTab = made?.kind === "step" ? tabsById.get(made.input) : undefined;
  const from = fromTab ? fullLabel(holders, fromTab) : null;

  const rowOf = (holder: FlowView["holders"][number] | null, fallback: { kind: FlowRowView["kind"]; name: string; stepId?: string; stepIndex?: number }): FlowRowView => {
    const isCurrent = holder !== null && current !== null && holder.id === current.id;
    return {
      kind: fallback.kind,
      ...(fallback.stepId === undefined ? {} : { stepId: fallback.stepId, stepIndex: fallback.stepIndex }),
      name: holder ? holder.title || fallback.name : fallback.name,
      holder: holder ? { id: holder.id, title: holder.title } : null,
      tabs: holder ? holder.tabs.map((tab) => ({ id: tab.id, kind: tab.kind, label: tabLabel({ tabName: tab.tabName, tabPos: tab.tabPos }), status: tab.stepStatus, running: runningIds.has(tab.id), generated: tab.madeFrom?.kind === "step" })) : [],
      current: isCurrent,
      from: isCurrent ? from : null,
      action: null,
    };
  };

  const rows: FlowRowView[] = [];
  // 録音（開いているのが録音ならその入れ物、ほかはフォルダの最初の録音の入れ物）。フォルダの外の録音は流れに無いので、居場所から行を作る
  const recHolder = (input.tab.kind === "rec" ? current : null) ?? holders.find((holder) => holder.tabs.some((tab) => tab.kind === "rec")) ?? null;
  const recRow = rowOf(recHolder, { kind: "rec", name: "録音" });
  if (!recHolder && input.tab.kind === "rec") {
    recRow.holder = input.tab.holder ? { id: input.tab.holder, title: input.tab.title } : null;
    recRow.name = input.tab.title || "録音";
    recRow.current = true;
    recRow.tabs = [{ id: input.tab.id, kind: "rec", label: "", status: null, running: false, generated: false }];
  }
  rows.push(recRow);
  // 文字起こし（#310）: 役割 transcript の入れ物とそのタブ（エンジンごと）。エンジンのメニューは、録音のタブか文字起こしのタブを開いているとき
  const transcriptHolder = holders.find((holder) => holder.role?.kind === "transcript") ?? null;
  const transcript = rowOf(transcriptHolder, { kind: "transcript", name: "文字起こし" });
  const madeFromRecording = made?.kind === "transcript" ? made.recording : null;
  const recording = input.tab.kind === "rec" ? input.tab.id : madeFromRecording;
  if (recording !== null && input.engines.length > 0) {
    const used = new Set((input.flow?.usedEngines ?? []).filter((item) => item.recording === recording).map((item) => item.engine));
    transcript.engines = input.engines.map((engine) => ({ id: engine, used: used.has(engine) }));
    transcript.recording = recording;
    transcript.action = "go";
  }
  rows.push(transcript);
  // 段階。開いているタブが段階の出力で、まだ済んでいない（待ち・作成中・失敗）なら、そこからは作れない。録音のタブからも作らない（入力は文字起こしのタブ）
  const unfinished = currentTab?.madeFrom?.kind === "step" && (currentTab.stepStatus === "wait" || currentTab.stepStatus === "run" || currentTab.stepStatus === "failed");
  const noInput = unfinished || input.tab.kind === "rec";
  for (const [index, step] of input.recipe.steps.entries()) {
    const holder = holders.find((item) => item.role?.kind === "step" && item.role.recipe === input.recipe.id && item.role.stepId === step.id) ?? null;
    const row = rowOf(holder, { kind: "step", name: step.name, stepId: step.id, stepIndex: index });
    if (index > pos) row.action = holder && holder.tabs.some((tab) => derivedFrom(tabsById, tab, input.tab.id)) ? "done" : noInput ? null : "go";
    rows.push(row);
  }
  return rows;
}
