import { createHash } from "node:crypto";
import type { Block } from "./types.ts";
import type { PageFields } from "./page-fields.ts";
import type { EditorSettings } from "./settings.ts";
import type { StepRecipe } from "./step-runs.ts";

export type StepReference = { id: string; blocks: Block[]; title?: string };
export type StepMaterials = {
  parentBlocks: Block[];
  backgroundBlocks: Block[];
  upstream: { id: string; blocks: Block[] }[];
  refs: StepReference[];
  fields: PageFields;
  settings: Pick<EditorSettings, "aiLang" | "glossary" | "aboutName" | "about">;
};
export type StepBasis = {
  source: string;
  artifacts: Record<string, string>;
  refs: string;
  info: string;
  guide: string;
  step: string;
};
export type StepStaleReason = "source" | "artifact" | "refs" | "info" | "guide" | "step";
const HEX = /^[0-9a-f]{64}$/;

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function inline(value: unknown): string {
  return Array.isArray(value) ? value.map((node) => object(node) ? node.type === "hardBreak" ? "\n" : node.type === "text" && typeof node.text === "string" ? node.text : "" : "").join("") : "";
}
export function stepBlockText(block: unknown): string {
  if (!object(block)) return "";
  if (block.type === "paragraph" || block.type === "heading") return inline(block.content);
  if (block.type === "image") return object(block.attrs) && typeof block.attrs.alt === "string" ? block.attrs.alt : "";
  return Array.isArray(block.content) ? block.content.map(stepBlockText).filter(Boolean).join("\n") : "";
}
export function stepBlocksText(blocks: readonly Block[]): string {
  return blocks.map((block) => stepBlockText(block).trim()).filter(Boolean).join("\n\n");
}
export function stepReferenceText(blocks: readonly Block[]): string {
  return blocks.map((block) => stepBlockText(block).trim()).filter(Boolean).join("\n");
}
export function computeStepBasis(recipe: StepRecipe, index: number, materials: StepMaterials): StepBasis {
  const step = recipe.steps[index];
  if (!step) throw new RangeError("step index out of range");
  const artifacts: Record<string, string> = {};
  for (const prior of recipe.steps.slice(0, index)) {
    artifacts[prior.id] = digest(stepBlocksText(materials.upstream.find((item) => item.id === prior.id)?.blocks ?? []));
  }
  const refs = materials.refs.map((ref) => [ref.id, stepReferenceText(ref.blocks).trim()]).filter(([, body]) => body !== "");
  return {
    source: digest(stepBlocksText(materials.parentBlocks)),
    artifacts,
    refs: digest(refs.length ? JSON.stringify(refs) : ""),
    info: digest(JSON.stringify([stepBlocksText(materials.backgroundBlocks), materials.fields.entities, materials.fields.terms, materials.settings.aiLang, materials.settings.glossary, materials.settings.aboutName, materials.settings.about])),
    guide: digest(JSON.stringify([(recipe.guide ?? "").trim(), recipe.terms ?? []])),
    step: digest(step.instruction.trim()),
  };
}
export function parseStepBasis(value: unknown): StepBasis | undefined {
  if (!object(value) || Object.keys(value).sort().join(",") !== "artifacts,guide,info,refs,source,step" || !object(value.artifacts)) return undefined;
  if (![value.source, value.refs, value.info, value.guide, value.step, ...Object.values(value.artifacts)].every((item) => typeof item === "string" && HEX.test(item))) return undefined;
  return value as StepBasis;
}
export function stepStaleReasons(recorded: StepBasis | undefined, current: StepBasis): StepStaleReason[] {
  if (!recorded) return [];
  const reasons: StepStaleReason[] = [];
  if (recorded.source !== current.source) reasons.push("source");
  if (new Set([...Object.keys(recorded.artifacts), ...Object.keys(current.artifacts)]).size !== Object.keys(current.artifacts).length ||
      Object.keys(current.artifacts).some((id) => recorded.artifacts[id] !== current.artifacts[id])) reasons.push("artifact");
  if (recorded.refs !== current.refs) reasons.push("refs");
  if (recorded.info !== current.info) reasons.push("info");
  if (recorded.guide !== current.guide) reasons.push("guide");
  if (recorded.step !== current.step) reasons.push("step");
  return reasons;
}
