/*
 * ページの本文のエディタの核（Mac・Web で共通。Issue #33・#45）。
 * 限定 AST（blocks.ts）と、その範囲だけを作れる TipTap の schema・「/」の一覧・行の種類・貼り付け・画像のノード。
 * 保存・通信・下書きは持たない（アプリの側が持つ）。画像の実体の置き場は `PageImages`・`ImageSrcOf` の口で渡す。
 */
export {
  BLOCK_NODE_NAMES,
  INLINE_NODE_NAMES,
  LINK_PROTOCOLS,
  MARK_NAMES,
  MAX_BLOCK_NESTING,
  MAX_LINK_CHARS,
  isSafeLinkHref,
  validateBlocks,
  type AstResult,
  type Block,
} from "./blocks";
export { IMAGE_NODE_NAME, docFromBlocks, imageAttrsOf, imageNode, replaceBlocks, type ImageAttrs } from "./doc";
export { CALLOUT_NODE_NAME, PageCallout } from "./callout";
export { AI_MARK_NAME, AiMark, PRESERVE_AI_MARKS_META } from "./ai-mark";
export {
  BLOCK_CHOICES,
  LINE_TYPE_CHOICES,
  addButtonVisible,
  blankLineAfterCursor,
  blankLineAround,
  fillBlankLine,
  filterBlockChoices,
  insertBlankLine,
  isEmptyParagraphAt,
  lineTypeOf,
  setLineType,
  type BlankLine,
  type BlockChoice,
  type BlockChoiceId,
  type LineTypeId,
} from "./block-types";
export { PageSlashMenu, SLASH_KEYS, SlashMenuStore, slashMenuStore, type SlashMenuSnapshot } from "./slash-menu";
export { imageFilesFrom, normalizePastedHtml } from "./paste";
export { buildPageExtensions, type PageExtensionsOptions } from "./page-extensions";
export { buildMarkdownExtensions } from "./markdown-extensions";
export { checkLinkInput, type LinkInputResult } from "./link-href";
export { IMAGE_PROBLEM_TEXT, PageImage, showImageProblem, type PageImageOptions } from "./image-node";
export {
  PAGE_IMAGE_DRAG_TYPE,
  encodePagePhotoDrag,
  insertPageImageAfterCursor,
  pageImageUses,
  pagePhotoFrom,
  pagePhotosBody,
  removePageImageNodes,
  updatePageImageNodes,
  type PagePhotoDrag,
  type PagePhotosBody,
} from "./page-photos";
export {
  IMAGE_ACCEPT,
  IMAGE_ALT_MAX_CHARS,
  IMAGE_CONTENT_TYPES,
  IMAGE_CREDIT_MAX_CHARS,
  IMAGE_MAX_BYTES,
  IMAGE_PAGE_MAX_COUNT,
  isAllowedImageSize,
  isAllowedImageType,
} from "./image-limits";
export type { ImageMeta, ImageProblem, ImageSrcOf, PageImageEntry, PageImageUploadResult, PageImages } from "./images";
export { blocksToMarkdown, markdownToBlocks, pageMarkdownSchema, type BlocksToMarkdown, type MarkdownToBlocks } from "./markdown";
export { isMacPlatform, isMod, isSaveShortcut, isSearchShortcut, shortcutOf, type ShortcutId } from "./shortcuts";
export { SAVE_STATUS_TEXT, headerStatus, type SaveStatus } from "./save-status";
export { formatWhen } from "./when";
export { PageChrome } from "./PageChrome";
export { PAGE_PHOTOS_ADD_TEXT, PAGE_PHOTOS_FULL_TEXT, PAGE_PHOTOS_LABEL, PAGE_PHOTOS_MIN_HEIGHT, PagePhotos, type PagePhotosProps } from "./PagePhotos";
