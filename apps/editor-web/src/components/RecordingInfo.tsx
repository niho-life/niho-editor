"use client";

import { useEffect, useId, useState } from "react";
import { Icon, ShellEntitiesEditor, ShellTermsEditor } from "niho-docs-ui/shell";
import { loadSettings } from "@/lib/settings-client";
import { usePageFields, type PageFieldsState } from "@/lib/use-page-fields";
import styles from "./RecordingInfo.module.css";

/**
 * 録音ページの「この録音について」（docs/architecture/editor-recipes-and-folders.md §3.3。モック editor-folders-v1）。
 * 登場人物・固有名詞・背景を録音ページ自身の欄（`PATCH /api/pages/{id}/fields`）に持つ。固有名詞は文字起こしのヒントに、
 * 三つとも工程の入力に入る。
 *
 * - 見出し行で畳む・開く。空のうちは開いた状態、何か入っていれば畳んだ状態から始まる（読み終えたときに一度だけ決める）。
 * - 畳んだときは 1 行の要約（「登場人物 2 · 固有名詞 3 · 背景あり」）。状態は文字で出す（色だけにしない）。
 * - 登場人物・固有名詞は「追加」で編集を開く（設定と同じ部品 ShellEntitiesEditor / ShellTermsEditor）。
 * - 背景は欄を離れたときに保存する（4,000 字まで）。
 * - 「共通 N」はアカウント共通の固有名詞（設定）の件数。読めなければ出さない。
 * - 話者人数・言語は文字起こしの開始の画面が持つ値で、この PR ではここに出さない。
 */
export function RecordingInfo({ pageId, fields: given }: { pageId: string; fields?: PageFieldsState }) {
  const own = usePageFields(given ? null : pageId);
  const fields = given ?? own;
  const bodyId = useId();
  const [open, setOpen] = useState<boolean | null>(null);
  const [shared, setShared] = useState<number | null>(null);

  const filled = fields.entities.length > 0 || fields.terms.length > 0 || fields.background.trim() !== "";
  // 開閉の初期値は読み終えたときの値（空なら開く・入っていれば畳む）。人が欄に触れた（フォーカス・「追加」）ときに
  // そのときの開閉を固定し、入力で「空でない」に変わっても勝手に畳まない。そのあとは見出しを押したときだけ替わる
  const shownOpen = open ?? (fields.loaded === "ready" ? !filled : false);
  const keepOpen = () => {
    if (open === null) setOpen(shownOpen);
  };
  useEffect(() => {
    let alive = true;
    void loadSettings().then(
      (result) => {
        if (alive && result.ok) setShared(result.settings.glossary.length);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const summary = [
    fields.entities.length > 0 ? `登場人物 ${fields.entities.length}` : null,
    fields.terms.length > 0 ? `固有名詞 ${fields.terms.length}` : null,
    fields.background.trim() !== "" ? "背景あり" : null,
  ].filter((part): part is string => part !== null);

  return (
    <section className={`${styles.box}${shownOpen ? "" : ` ${styles.closed}`}`} aria-label="この録音について" data-recording-info="">
      <button type="button" className={styles.head} aria-expanded={shownOpen} aria-controls={bodyId} onClick={() => setOpen(!shownOpen)}>
        <Icon name="mic" />
        <b>この録音について</b>
        <span className={styles.summary}>{shownOpen ? "" : summary.length > 0 ? summary.join(" · ") : fields.loaded === "ready" ? "まだ何もありません" : ""}</span>
        <Icon name="caret-down" className={styles.chev} />
      </button>
      <div id={bodyId} className={styles.body} hidden={!shownOpen}>
        {fields.open ? (
          <div className={styles.editors}>
            <ShellEntitiesEditor entities={fields.entities} max={fields.max.entities} busy={fields.busy} onChange={fields.onEntities} onCancel={fields.onCancel} onSave={fields.onSave} />
            <ShellTermsEditor
              terms={fields.terms}
              max={fields.max.terms}
              busy={fields.busy}
              onChange={fields.onTerms}
              onCancel={fields.onCancel}
              onSave={fields.onSave}
              heading="この録音の固有名詞"
              help="文字起こしのヒントと AI の提案に、この表記のとおりに書くよう渡します。表記のない行は保存できません。"
              name="この録音の固有名詞"
            />
          </div>
        ) : (
          <>
            <div className={styles.row}>
              <span className={styles.label}>登場人物</span>
              <div className={styles.chips}>
                {fields.entities.map((entity) => (
                  <span key={entity.name} className={styles.chip}>
                    <span>{entity.name}</span>
                    {entity.role && <small>{entity.role}</small>}
                  </span>
                ))}
                <button
                  type="button"
                  className={styles.add}
                  aria-label="登場人物を追加・編集"
                  onClick={() => {
                    keepOpen();
                    fields.onOpen();
                  }}
                >
                  ＋ 追加
                </button>
              </div>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>固有名詞</span>
              <div className={styles.chips}>
                {fields.terms.map((term) => (
                  <span key={term.term} className={styles.chip}>
                    <span>{term.term}</span>
                  </span>
                ))}
                <button
                  type="button"
                  className={styles.add}
                  aria-label="固有名詞を追加・編集"
                  onClick={() => {
                    keepOpen();
                    fields.onOpen();
                  }}
                >
                  ＋ 追加
                </button>
                {shared !== null && shared > 0 && (
                  <span className={styles.tag} title="設定の固有名詞（どの録音にも効く）">
                    共通 {shared}
                  </span>
                )}
              </div>
            </div>
            <div className={styles.row}>
              <label className={styles.label} htmlFor={`${bodyId}-bg`}>
                背景
              </label>
              <textarea
                id={`${bodyId}-bg`}
                className={styles.textarea}
                rows={3}
                maxLength={fields.max.backgroundChars}
                placeholder="取材の目的、相手、場所など"
                value={fields.background}
                readOnly={fields.loaded !== "ready"}
                onFocus={keepOpen}
                onChange={(event) => fields.onBackground(event.target.value)}
                onBlur={fields.onSaveBackground}
              />
            </div>
          </>
        )}
        {fields.note && (
          <p role="alert" className={styles.note}>
            {fields.note}
          </p>
        )}
      </div>
    </section>
  );
}
