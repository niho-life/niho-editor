"use client";

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { fitTitleHeight } from "./BlockEditor";

/** タイトルを打ち終えてから保存するまでの間（打つたびには保存しない）。 */
const TITLE_SAVE_MS = 500;

/** 名前を保存する。保存できなかったときは false を返す（返さなければ保存できたものとして扱う）。 */
export type TitleCommit = (title: string) => void | Promise<boolean>;

/**
 * ページのタイトル（文書・録音のページの大きな見出しの入力欄）。打つとその場で名前が変わり（レール・パンくずも `onInput`）、
 * 打ち終えて 500ms で `onCommit`（renamePage）。離れる・閉じるときは待たずに書き残す。保存できなかった名前は残し、次に打つ・離れる・
 * 閉じるときにもう一度書く。Enter か（最後の位置での）↓ で `onEnter`（本文の先頭へ）。長いタイトルは折り返す（1 行から書いた分だけ
 * 伸びる欄。改行は入れない。貼った改行は空白にする）。
 */
export function PageTitle(props: {
  value: string;
  placeholder: string;
  /** 作ったばかりのページ（開いたらタイトルにフォーカス）。 */
  autoFocus?: boolean;
  disabled?: boolean;
  saveOnIdle?: boolean;
  commitOnUnmount?: boolean;
  ariaLabel?: string;
  onCancel?: () => void;
  onFocused?: () => void;
  onInput?: (title: string) => void;
  onCommit?: TitleCommit;
  onEnter?: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  const commitRef = useRef(props.onCommit);
  commitRef.current = props.onCommit;

  const commit = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const title = pending.current;
    pending.current = null;
    if (title === null) return;
    void Promise.resolve(commitRef.current?.(title)).then((saved) => {
      // 保存できなかった名前は残す（その間に打ち足していれば、新しい方を書く）
      if (saved === false && pending.current === null) pending.current = title;
    });
  };

  // 作ったばかりのページ: 開いたとき（と、開いた後に印が付いたとき）にタイトルへ
  const autoFocus = props.autoFocus ?? false;
  const onFocusedRef = useRef(props.onFocused);
  onFocusedRef.current = props.onFocused;
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    onFocusedRef.current?.();
  }, [autoFocus]);

  // ページを移る・閉じるときは、打ちかけの名前を待たずに保存する
  const unmountCommit = useRef(props.commitOnUnmount ?? true);
  useEffect(() => () => {
    if (unmountCommit.current) commit();
    else if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // 書いた分だけ伸ばす（値が変わったときと、欄の幅が変わったとき。窓の幅だけでなく、レールの開閉で列の幅が変わっても測り直す）
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    return fitTitleHeight(element);
  }, [props.value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語入力の確定の Enter では移らない
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && props.onCancel) {
      event.preventDefault();
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null; pending.current = null;
      props.onCancel(); inputRef.current?.blur(); return;
    }
    if (event.key !== "Enter" && event.key !== "ArrowDown") return;
    // 折り返したタイトルの途中の ↓ は、欄の中で次の行へ（最後の位置からだけ本文へ）
    const element = event.currentTarget;
    if (event.key === "ArrowDown" && element.selectionEnd < element.value.length) return;
    event.preventDefault();
    commit();
    if (props.onEnter) props.onEnter();
    else inputRef.current?.blur();
  };

  return (
    <textarea
      ref={inputRef}
      className="ptitle"
      rows={1}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel ?? "タイトル"}
      spellCheck={false}
      disabled={props.disabled}
      onChange={(event) => {
        // 改行は入れない（貼った改行は空白にする）
        const title = event.target.value.replace(/[\r\n]+/g, " ");
        pending.current = title;
        props.onInput?.(title);
        if (timer.current !== null) window.clearTimeout(timer.current);
        if (props.saveOnIdle !== false) timer.current = window.setTimeout(commit, TITLE_SAVE_MS);
      }}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}
