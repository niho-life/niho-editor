import { Icon } from "./icons";
import type { ShellButtonTone, ShellStepState } from "./types";

export type ShellStep = { id: string; label: string; state: ShellStepState; notice?: string };

/** 帯のボタン（「ここから作り直す」「やめる」など）。何が出るかは呼ぶ側が決める。 */
export type ShellStepsAction = { id: string; label: string; tone?: ShellButtonTone; busy?: boolean };

/** 録音から始められる手順（記事にする・議事録にする…）。 */
export type ShellStepsChoice = { id: string; label: string; unusableReason?: string | null };

/** 状態の言葉。色だけで状態を表さないので、丸の形と合わせていつも文字でも出す（設計 §11）。 */
const SAY: Record<ShellStepState, string> = { done: "済み", run: "作成中", wait: "待機", failed: "失敗", stale: "前提変更" };

export function shellStepSay(state: ShellStepState): string {
  return SAY[state];
}

function StepList({ steps, currentId, band, onSelect }: { steps: ShellStep[]; currentId?: string; band?: boolean; onSelect?: (id: string) => void }) {
  return (
    <ol className={`es-steps${band ? " es-steps--band" : ""}`} aria-label="手順">
      {steps.map((step) => (
        <li key={step.id}>
          <button
            type="button"
            className={`es-step es-step--${step.state}${step.id === currentId ? " es-step--cur" : ""}`}
            aria-current={step.id === currentId ? "step" : undefined}
            onClick={() => onSelect?.(step.id)}
          >
            <i aria-hidden="true" />
            {step.label}
            <small>{step.notice ?? SAY[step.state]}</small>
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * 録音から作る手順（文字起こし修正 › 記事方針 › 記事本文）。段階ごとにページになり、押すとそのページへ行く。
 * `band` を渡すと本文の列の上の帯（設計 §7.2。段階の名前・状態・手順の名前と、作り直す・やめるのボタン）。
 * 渡さなければ情報パネルの中の縦の並び（モック v6 の「手順」のカード）。
 */
export function ShellSteps({
  steps,
  currentId,
  onSelect,
  onRedo,
  band,
  title,
  note,
  actions,
  onAction,
}: {
  steps: ShellStep[];
  currentId?: string;
  onSelect?: (id: string) => void;
  /** 手順のサブページで出す「この手順を作り直す」（縦の並びのときだけ）。 */
  onRedo?: () => void;
  /** 本文の列の上の帯として出す。 */
  band?: boolean;
  /** 帯の見出し（「記事制作の手順」）。 */
  title?: string;
  /** 帯の下の一言（いま何が起きているか・失敗の理由）。変わると読み上げる（role="status"）。 */
  note?: string;
  /** 帯のボタン。 */
  actions?: readonly ShellStepsAction[];
  onAction?: (id: string) => void;
}) {
  if (!band) {
    return (
      <>
        <StepList steps={steps} currentId={currentId} onSelect={onSelect} />
        {onRedo && (
          <div className="es-redo">
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={onRedo}>
              この手順を作り直す
            </button>
          </div>
        )}
      </>
    );
  }
  return (
    <section className="es-stepband" aria-label={title ? `${title}の進み` : "手順の進み"}>
      {title && (
        <p className="es-stepband-ttl">
          <Icon name="spark" />
          {title}
        </p>
      )}
      <StepList steps={steps} currentId={currentId} band onSelect={onSelect} />
      {/* 状態が変わったことは、この一言が読み上げる（空のままでも置いておく。後から現れる領域は読み上げられないことがある） */}
      <p className="es-stepband-note" role="status">
        {note ?? ""}
      </p>
      {actions && actions.length > 0 && (
        <div className="es-redo">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`es-btn es-btn--${action.tone ?? "outline"} es-btn--sm${action.busy ? " es-btn--busy" : ""}`}
              aria-disabled={action.busy || undefined}
              onClick={() => {
                if (!action.busy) onAction?.(action.id);
              }}
            >
              {action.busy && <i className="es-busy" aria-hidden="true" />}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** 録音ページの「この録音から」（まだ手順を始めていないときだけ出す）。最初の 1 つが主ボタン。 */
export function ShellStepsStart({
  choices,
  busy,
  onPick,
  onChangeSteps,
}: {
  choices: readonly ShellStepsChoice[];
  /** 始める要求を送っている間（押せない見た目にして二度押させない）。 */
  busy?: boolean;
  onPick?: (id: string) => void;
  /** 設定の「手順」へ。 */
  onChangeSteps?: () => void;
}) {
  return (
    <div className="es-makefrom" role="group" aria-label="この録音から">
      <span>この録音から</span>
      {choices.map((choice, index) => (
        <button
          key={choice.id}
          type="button"
          className={`es-btn es-btn--${index === 0 ? "primary" : "outline"} es-btn--sm${busy ? " es-btn--busy" : ""}`}
          aria-disabled={busy || Boolean(choice.unusableReason) || undefined}
          onClick={() => {
            if (!busy && !choice.unusableReason) onPick?.(choice.id);
          }}
        >
          {busy && <i className="es-busy" aria-hidden="true" />}
          {choice.unusableReason ? `${choice.label}（利用できません: ${choice.unusableReason}）` : choice.label}
        </button>
      ))}
      {onChangeSteps && (
        <>
          <span className="es-sp" />
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={onChangeSteps}>
            手順を変える
          </button>
        </>
      )}
    </div>
  );
}
