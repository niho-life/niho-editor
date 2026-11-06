/*
 * editor の枠（shell）の公開 export（モック v6 / #48 フェーズ1・2）。
 * props 駆動の表示部品だけ。DocsHost・fetch・保存は持たない。スタイルは niho-docs-ui/styles/shell.css（読むのは呼ぶ側）。
 */
export { EditorShell, type EditorShellProps, type ShellSettingsLink } from "./editor-shell";
export {
  ShellPanelClose,
  ShellPanelHead,
  ShellSash,
  ShellSidePane,
  type EditorShellDock,
  type ShellPanelHeadProps,
  type ShellSashProps,
  type ShellSidePaneProps,
} from "./dock";
export {
  SHELL_DND,
  SHELL_DOCKS_DEFAULT,
  SHELL_DOCK_DEFAULT,
  SHELL_DOCK_MAX,
  SHELL_DOCK_MIN,
  SHELL_DOCK_STRIP,
  SHELL_PANELS,
  SHELL_PANEL_HOME,
  SHELL_PANEL_ICON,
  SHELL_PANEL_MIN_HEIGHT,
  SHELL_PANEL_NAME,
  clampDockWidth,
  closePanel,
  computeShellDock,
  dockOf,
  dockPanels,
  dockWidthRange,
  isShellDockSide,
  isShellPanelId,
  movePanel,
  openPanel,
  panelDropTarget,
  panelGhostRect,
  panelShares,
  resizeDockPanels,
  type ShellAiPlace,
  type ShellDockFit,
  type ShellDockInput,
  type ShellDockPanel,
  type ShellDockSide,
  type ShellDockWidthKey,
  type ShellDockWidths,
  type ShellDocks,
  type ShellPanelId,
  type ShellPanelShare,
  type ShellPanelTarget,
} from "./dock-layout";
export { Icon } from "./icons";
export { ShellMenu, useMenuDismiss, type ShellMenuProps } from "./menu";
export { StatusDot } from "./status-dot";
export { shellPublishButton, shellStatus } from "./status";
export { ShellTools, ShellMobileToolbar, type ShellToolAction, type ShellToolsProps } from "./tools";
export { ShellHeader, ShellLocation, shellMoreItems, type ShellHeaderProps, type ShellLocationItem } from "./header";
export { ShellSidebar, type ShellDropTarget, type ShellSidebarProps } from "./sidebar";
export { ShellBrand } from "./brand";
export { NEW_PAGE_KINDS, NewPageMenu, type NewPageKind } from "./new-page-menu";
export { ShellRail, ShellRailSection, type ShellRailProps, type ShellRailSectionProps } from "./rail";
export { ShellSteps, ShellStepsStart, shellStepSay, type ShellStep, type ShellStepsAction, type ShellStepsChoice } from "./steps";
export { ShellChat, type ShellChatAction, type ShellChatMessage, type ShellChatProps } from "./chat";
export { ShellPageSettings, type ShellPageSettingsProps } from "./page-settings";
export { ShellPageInfo, type ShellPageInfoProps } from "./page-info";
export { SHELL_TERMS_TEXT, ShellEntitiesEditor, ShellTermsEditor, type EditorSettingsEntityDraft, type EditorSettingsTermDraft } from "./terms-editor";
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
  linkTo,
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
  EDITOR_SETTINGS_HREF,
  EDITOR_SETTINGS_TEXT,
  EditorSettingsAboutPage,
  EditorSettingsHub,
  EditorSettingsRecipePage,
  EditorSettingsTermsPage,
  EditorTermRows,
  blankStep,
  duplicateStep,
  moveStep,
  recipeMenuItems,
  stepMenuItems,
  type EditorRecipeSheet,
  type EditorSettingsAboutPageProps,
  type EditorSettingsAiLang,
  type EditorSettingsAbout,
  type EditorSettingsAudioFacts,
  type EditorSettingsGuideExtraction,
  type EditorSettingsHubProps,
  type EditorSettingsRecipe,
  type EditorSettingsRecipePageProps,
  type EditorSettingsRecipeValidation,
  type EditorSettingsSample,
  type EditorSettingsStep,
  type EditorSettingsStorageUsage,
  type EditorSettingsTerm,
  type EditorSettingsTermsPageProps,
  type EditorSettingsUsage,
  type EditorTermEditing,
  type EditorTermRowsProps,
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
