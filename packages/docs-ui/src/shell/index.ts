/*
 * editor の枠（shell）の公開 export（モック v6 / #48 フェーズ1・2）。
 * props 駆動の表示部品だけ。DocsHost・fetch・保存は持たない。スタイルは niho-docs-ui/styles/shell.css（読むのは呼ぶ側）。
 */
export { EditorShell, type EditorShellProps } from "./editor-shell";
export { Icon } from "./icons";
export { ShellMenu, useMenuDismiss, type ShellMenuProps } from "./menu";
export { StatusDot } from "./status-dot";
export { shellPublishButton, shellStatus } from "./status";
export { ShellTools, ShellMobileToolbar, type ShellToolAction, type ShellToolsProps } from "./tools";
export { ShellHeader, shellMoreItems, type ShellHeaderProps } from "./header";
export { ShellSidebar, shellAccountItems, type ShellSidebarProps } from "./sidebar";
export { NewPageMenu, type NewPageKind } from "./new-page-menu";
export { ShellRail, ShellRailSection, type ShellRailProps, type ShellRailSectionProps } from "./rail";
export { ShellSteps, ShellStepsStart, shellStepSay, type ShellStep, type ShellStepsAction, type ShellStepsChoice } from "./steps";
export { ShellChat, type ShellChatAction, type ShellChatMessage, type ShellChatProps } from "./chat";
export { ShellPageSettings, type ShellPageSettingsProps } from "./page-settings";
export { ShellEntitiesEditor, ShellTermsEditor, type EditorSettingsEntityDraft } from "./editor-settings";
export { ShellBubbleMenu, ShellSelectionBar, type ShellBubbleMenuProps, type ShellSelectionActions } from "./bubble";
export {
  ShellAddRow,
  ShellBlockMenu,
  ShellBody,
  ShellPage,
  type ShellBodyBlock,
  type ShellInline,
  type ShellMetaItem,
  type ShellPageProps,
} from "./page";
export {
  SHELL_TONES,
  ShellMakeFrom,
  ShellRecording,
  type ShellRecordingProps,
  type ShellSegment,
  type ShellSpeaker,
  type ShellSpeakerResult,
  type ShellTone,
} from "./transcript";
export { ShellProposal, type ShellDiffPart, type ShellProposalBlock, type ShellProposalProps } from "./proposal";
export { RecordingStart, type RecordingHow, type RecordingNext, type RecordingStartProps } from "./recording-start";
export { ShellSheet, type ShellSheetProps } from "./sheet";
export {
  PublishSheet,
  SHELL_ADD_DEST_OPTIONS,
  type AddDestOption,
  type AddDestProps,
  type PublishDestOption,
  type PublishDoneProps,
  type PublishExtras,
  type PublishFormProps,
  type PublishRange,
  type PublishSheetProps,
  type PublishSlug,
  type PublishStopProps,
} from "./publish-sheet";
export { LoginScreen, type LoginScreenProps } from "./login";
export { PublishPreview, type PublishPreviewDest, type PublishPreviewProps } from "./preview";
export {
  SHELL_DEST_PILL,
  ShellDestPill,
  ShellField,
  ShellInvite,
  ShellKv,
  ShellKvs,
  ShellPills,
  ShellRole,
  ShellSection,
  ShellSettingsPage,
  ShellTable,
  ShellToggle,
} from "./settings-parts";
export { DestinationsPage, SitePage, type DestinationRow, type DestinationsPageProps, type SitePageProps } from "./destinations";
export {
  EDITOR_DESTINATIONS_TEXT,
  EditorDestinationsPage,
  EditorSitePage,
  type EditorAddSiteDraft,
  type EditorDestinationFace,
  type EditorDestinationMode,
  type EditorDestinationSite,
  type EditorDestinationsPageProps,
  type EditorIssuedKey,
  type EditorSiteKeyView,
  type EditorSitePageProps,
  type EditorSitePublished,
} from "./editor-destinations";
export { AccountPage, type AccountLink, type AccountPageProps, type AccountRole } from "./account";
export {
  EDITOR_SETTINGS_NAV,
  EDITOR_SETTINGS_TEXT,
  EditorSettingsPage,
  type EditorSettingsAiLang,
  type EditorSettingsEngine,
  type EditorSettingsPageProps,
  type EditorSettingsRecipe,
  type EditorSettingsStep,
  type EditorSettingsStorage,
  type EditorSettingsTerm,
  type EditorSettingsTermDraft,
  type EditorSettingsTranscription,
  type EditorSettingsUsage,
} from "./editor-settings";
export {
  SettingsPage,
  type SettingsAiLang,
  type SettingsEngine,
  type SettingsPageProps,
  type SettingsProfileField,
  type SettingsSaveTo,
} from "./settings-page";
export type {
  ShellButtonTone,
  ShellDest,
  ShellIconName,
  ShellLang,
  ShellListItem,
  ShellMenuItem,
  ShellPageKind,
  ShellPublication,
  ShellStatusState,
  ShellStepState,
} from "./types";
