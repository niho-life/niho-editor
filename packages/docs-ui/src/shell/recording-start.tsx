import { useId } from "react";
import { Icon } from "./icons";

export type RecordingHow = "mic" | "file";
export type RecordingNext = "article" | "minutes" | "none";

const NEXTS: { id: RecordingNext; label: string; detail: string }[] = [
  { id: "article", label: "記事にする", detail: "文字起こし修正 › 記事方針 › 記事本文" },
  { id: "minutes", label: "議事録にする", detail: "議事録 › 共有用の要約" },
  { id: "none", label: "文字起こしだけ", detail: "あとから手順を選べます" },
];

export type RecordingStartProps = {
  how: RecordingHow;
  onHow: (how: RecordingHow) => void;
  /** 選んだ音声ファイル（how が file のとき）。 */
  file?: { name: string; detail: string };
  /** ファイルを選ぶ前の欄の一言（取り込める形式）。無ければ「.m4a .mp3 .wav、文字起こし済みの .vtt も」。 */
  fileHint?: string;
  /** 欄の下の一言（長さ・容量の上限と、クラウドの音声が消える日数）。無ければ出さない。 */
  limitsNote?: string;
  background: string;
  onBackground: (value: string) => void;
  /** 登場人物。話者の名前になる。 */
  people: { name: string; tone: "a" | "b" }[];
  onAddPerson?: () => void;
  /** 固有名詞（設定から引き継いだもの）。 */
  terms: string;
  onEditTerms?: () => void;
  next: RecordingNext;
  onNext: (next: RecordingNext) => void;
  onStart: () => void;
  /** 下の主ボタンの文言（録音中の「止める」、音声の「取り込む」など）。無ければ how に応じて「録音をはじめる」「文字起こしをはじめる」。 */
  startLabel?: string;
  /**
   * 文字起こしをどこで行うかの一言（下の帯）。既定は「文字起こしは NIHO クラウドで行います」。
   * Mac は「この Mac」も選べるので、選んでいるものを文にして渡す（設計 §7.1）。
   */
  engineNote?: string;
  /** 渡すと、その一言の右に設定へ行くボタンを出す。 */
  onEditEngine?: () => void;
  /** 開始のボタンを押せなくする（録音の準備ができていない・取り込み中）。 */
  busy?: boolean;
};

/**
 * 「録音から」の開始画面。録音する／音声ファイルを置く → 上限の案内 → 背景情報・登場人物・固有名詞 → このあと。
 * 上限（limitsNote）は呼び出し側がサーバーの値から組む（画面に数を埋め込まない）。
 * 文字起こしをどこで行うかは `engineNote` で呼び出し側から渡す。送信先は既定値から推測しない。
 */
export function RecordingStart(props: RecordingStartProps) {
  const backgroundId = useId();
  const nextId = useId();
  return (
    <div className="es-canvas-in es-start">
      <h1>録音から</h1>
      <p className="es-lead2">話したことを文字にして、そのまま直せます。背景を書いておくと、文字起こしも AI の提案も当たりやすくなります。</p>
      <button type="button" className="es-bigrec" aria-pressed={props.how === "mic"} onClick={() => props.onHow("mic")}>
        <Icon name="mic" />
        録音する
      </button>
      <div className="es-orline" aria-hidden="true">
        または
      </div>
      <button type="button" className={`es-drop${props.how === "file" ? " es-drop--on" : ""}`} aria-pressed={props.how === "file"} onClick={() => props.onHow("file")}>
        {props.how === "file" && props.file ? (
          <>
            <b>{props.file.name}</b>
            <small>{props.file.detail}</small>
          </>
        ) : (
          <>
            <b>音声ファイルをここにドロップ</b>
            <small>{props.fileHint ?? ".m4a .mp3 .wav、文字起こし済みの .vtt も"}</small>
          </>
        )}
      </button>
      {props.limitsNote && <p className="es-note">{props.limitsNote}</p>}
      <div className="es-fld">
        <h2>
          <label htmlFor={backgroundId}>背景情報</label> <em>任意</em>
        </h2>
        <textarea
          id={backgroundId}
          className="es-area"
          placeholder="何の録音か、どこで、何のために。「NIHO kamakura のコミュニティディナーについて、ホストの Takuya さんに聞いた。旅行者向けの記事にする。」"
          value={props.background}
          onChange={(event) => props.onBackground(event.target.value)}
        />
      </div>
      <div className="es-fld">
        <h2>
          登場人物 <em>話者の名前になります</em>
        </h2>
        <ul className="es-people" aria-label="登場人物">
          {props.people.map((person) => (
            <li key={person.name}>
              <i className={`es-tone es-tone--${person.tone}`} aria-hidden="true" />
              {person.name}
            </li>
          ))}
          <li>
            <button type="button" onClick={props.onAddPerson}>
              <Icon name="plus" />
              足す
            </button>
          </li>
        </ul>
      </div>
      <div className="es-fld">
        <h2>
          固有名詞 <em>設定から引き継いでいます</em>
        </h2>
        <div className="es-terms">
          <code>{props.terms}</code>
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={props.onEditTerms}>
            編集
          </button>
        </div>
      </div>
      <div className="es-fld" role="radiogroup" aria-labelledby={nextId}>
        <h2 id={nextId}>このあと</h2>
        {NEXTS.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={props.next === item.id} className={`es-opt${props.next === item.id ? " es-opt--on" : ""}`} onClick={() => props.onNext(item.id)}>
            <i aria-hidden="true" />
            {item.label}
            <small>{item.detail}</small>
          </button>
        ))}
      </div>
      <div className="es-foot2">
        <span>{props.engineNote ?? "文字起こしの送信先は未設定です"}</span>
        {props.onEditEngine && (
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={props.onEditEngine}>
            変える
          </button>
        )}
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--primary" disabled={props.busy ?? false} onClick={props.onStart}>
          {props.startLabel ?? (props.how === "mic" ? "録音をはじめる" : "文字起こしをはじめる")}
        </button>
      </div>
    </div>
  );
}
