"use client";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, memo, KeyboardEvent } from "react";
import { ChevronDown, ListChecks, Loader2, Mic, Paperclip, Plus, Shrink, Sparkles, Wrench, Zap } from "lucide-react";
import { getSubmitDuringRunBehavior } from "@/lib/composer-prefs";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { ActiveGoal, ActivePlan } from "@/lib/web-mode-state";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/field";
import { useDictation } from "@/hooks/useDictation";
import type { GenerationSpeedInfo, SessionStatsInfo } from "@/lib/pi-types";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { ContextDetailPanel } from "./ComposerPanels";
import { clearDraft, getDraft, setDraft } from "@/lib/draft-store";
import { expandWebSlashCommand } from "@/lib/web-slash-commands";
import type { AttachedImage, AttachedTextFile } from "./ChatInput-draft-attachments";
import {
  draftFilesToAttachedFiles,
  draftImagesToAttachedImages,
  imageToDraftImage,
  revokeImagePreview,
  textFileToDraftFile,
} from "./ChatInput-draft-attachments";
import {
  BUILTIN_SLASH_COMMAND_DEFS,
  CLIENT_BUILTIN_COMMAND_NAMES,
  SLASH_SOURCE_GROUP_LABEL_KEYS,
  SLASH_SOURCE_ORDER,
  SLASH_SOURCES,
  isDormantSkillCommand,
  slashMatchRank,
  type SlashCommandPaletteItem,
  type SlashCommandSource,
} from "./ChatInput-slash-commands";
import {
  COMPOSER_MODELS_STORAGE_KEY,
  compareModelOptions,
  filterModelOptions,
  formatTokenCount,
  readVisibleModelKeys,
  type ModelOption,
} from "./ChatInput-model-options";
import { ModelPickerPanel } from "./ChatInput-model-picker";
import { ComposerModeStatus, ModelErrorBanner, QueuedActionButton } from "./ChatInput-banners";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import {
  composeMessageWithTextAttachments,
  describeTextAttachmentSkip,
  formatAttachmentBytes,
  MAX_ATTACHED_TEXT_FILES,
  selectTextAttachments,
} from "@/lib/chat-attachments";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  validateOutgoingPrompt,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { selectableThinkingLevels } from "@/lib/thinking-levels";
import type { ToolPreset } from "@/lib/tool-presets";

export type { AttachedImage, AttachedTextFile } from "./ChatInput-draft-attachments";
export { filterModelOptions } from "./ChatInput-model-options";
export { ModelErrorBanner } from "./ChatInput-banners";

const TOOL_PRESET_OPTIONS: Array<{ value: ToolPreset; descriptionKey: string }> = [
  { value: "none", descriptionKey: "chatInput.toolPresetNone" },
  { value: "default", descriptionKey: "chatInput.toolPresetDefault" },
  { value: "full", descriptionKey: "chatInput.toolPresetFull" },
];

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; supportsFastMode?: boolean }[];
  modelError?: string | null;
  modelsLoading?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  fastModeSupported?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: string;
  onThinkingLevelChange?: (level: string) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  /** Browser-side tool preset, applied when spawning NEW sessions. */
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  /** Display name for the current model when the catalog does not know it. */
  modelNameOverride?: string | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  onAbortRetry?: () => void;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  /** True while the advisor model is actively reviewing the running turn. */
  advisorActive?: boolean;
  /** Resolved advisor role (display model + reasoning) for the composer tooltips. */
  advisorModel?: { name: string; reasoning: string | null } | null;
  /** Compact the session context from the composer toolbar. */
  onCompact?: () => void;
  /** Live context totals feeding the composer context ring. */
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  /** Session stats shown in the context ring popover. */
  sessionStats?: SessionStatsInfo | null;
  /** Model capacity shown in the context ring popover. */
  modelCapacity?: { contextWindow?: number; maxTokens?: number } | null;
  /** Generation speed shown in the context ring popover. */
  generationSpeed?: GenerationSpeedInfo | null;
  /** Remove one queued message from the queue panel (Edit/Delete/Steer). */
  onRemoveQueuedMessage?: (text: string) => void;
  /** Relabel the first queued follow-up as a steering message. */
  onPromoteQueuedToSteer?: (text: string) => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  activeGoal?: ActiveGoal | null;
  activePlan?: ActivePlan | null;
  advisorEnabled?: boolean;
  /** Toggle the per-chat advisor (composer icon + /advisor command). */
  onAdvisorChange?: (enabled: boolean) => void;
  /** Collapse the entire composer into a minimized bar. */
  onMinimize?: () => void;
  /** Active status label attached to the composer's top edge (e.g. "Waiting for model..."). */
  statusText?: string | null;
  /** Open Settings → API Keys & Providers from the model picker footer. */
  onOpenProviders?: () => void;
}

export interface ChatInputHandle {
  focus: () => void;
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
  openContextPanel: () => void;
}
const COMPOSITION_END_ENTER_GRACE_MS = 100;

// The history / slash / @ menus are absolutely positioned relative to the
// composer input. On the empty-session page the composer sits inside an
// `overflow-y-auto` wrapper, so the part of a menu that extends past that
// wrapper's edge gets clipped. Before paint we measure the nearest clipping
// ancestor and pick the side (above/below the input) with more room, then cap
// the menu height so it never overflows that boundary.
const MENU_EDGE_PAD = 8;

function getMenuBoundary(el: HTMLElement | null): { top: number; bottom: number } {
  if (typeof window === "undefined" || !el) return { top: 0, bottom: 0 };
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (getComputedStyle(node).overflowY !== "visible") {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    node = node.parentElement;
  }
  return { top: 0, bottom: window.innerHeight };
}

type MenuPlacement = "up" | "down";

/**
 * Resolves the anchor rect (the relative parent of the menu) and the nearest
 * clipping boundary, then returns which side to open on and the max height
 * (CSS px) that fits. `vhFraction`/`capPx` reproduce the menu's existing
 * `min(<vhFraction>vh, <capPx>px)` default so the unconstrained case is
 * byte-for-byte unchanged.
 */
function useDropdownFlip(
  open: boolean,
  menuRef: React.RefObject<HTMLDivElement | null>,
  vhFraction: number,
  capPx: number,
) {
  const [placement, setPlacement] = useState<MenuPlacement>("up");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement("up");
      setMaxHeight(null);
      return;
    }
    const menu = menuRef.current;
    const anchor = menu?.parentElement;
    if (!menu || !anchor) return;
    const boundary = getMenuBoundary(menu);
    const rect = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const defaultPx = Math.min(vh * vhFraction, capPx);
    // The menu bottom (up) / top (down) is anchored 8px off the input edge.
    const upSpace = rect.top - 8 - boundary.top - MENU_EDGE_PAD;
    const downSpace = boundary.bottom - (rect.bottom + 8) - MENU_EDGE_PAD;

    if (upSpace >= defaultPx || upSpace >= downSpace) {
      setPlacement("up");
      setMaxHeight(Math.max(0, Math.min(defaultPx, upSpace)));
    } else {
      setPlacement("down");
      setMaxHeight(Math.max(0, Math.min(defaultPx, downSpace)));
    }
  }, [open, menuRef, vhFraction, capPx]);

  return { placement, maxHeight };
}

function menuDropStyle(placement: MenuPlacement, maxHeight: number | null): React.CSSProperties {
  return {
    ...(placement === "down" ? { top: "calc(100% + 8px)" } : { bottom: "calc(100% + 8px)" }),
    maxHeight: maxHeight !== null ? `${maxHeight}px` : undefined,
  };
}


export const ChatInput = memo(forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, modelsLoading, onModelChange, fastModeEnabled, fastModeActive, fastModeSupported, onFastModeChange,
  onAbortCompaction, isCompacting, compactResult,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap, modelNameOverride,
  toolPreset, onToolPresetChange,
  retryInfo, queuedMessages, inputHistory = [], onAbortRetry,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  onPromptWithStreamingBehavior,
  advisorActive,
  advisorModel,
  onCompact,
  contextUsage,
  sessionStats,
  modelCapacity,
  generationSpeed,
  onRemoveQueuedMessage,
  onPromoteQueuedToSteer,
  draftKey,
  cwd,
  activeGoal,
  activePlan,
  advisorEnabled,
  onAdvisorChange,
  onMinimize,
  statusText,
  onOpenProviders,
}: Props, ref) {
  const isMobile = useIsMobile();
  const { t, tn, locale } = useI18n();
  const modelCollator = React.useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }),
    [locale],
  );
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [queuedDeleteTarget, setQueuedDeleteTarget] = useState<{
    text: string;
    draftKey: string | undefined;
    queue: Props["queuedMessages"];
  } | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusExpanded, setPlusExpanded] = useState<"tools" | "advisor" | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [attachedTextFiles, setAttachedTextFiles] = useState<AttachedTextFile[]>(() => (
    draftKey ? draftFilesToAttachedFiles(getDraft(draftKey)?.files) : []
  ));
  const [attachError, setAttachError] = useState<string | null>(null);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && attachedTextFiles.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const contextWrapRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const attachedTextFilesRef = useRef(attachedTextFiles);
  // Bumped whenever the user clears/sends the composer: in-flight FileReader
  // and file.text() reads must not re-append their results afterwards.
  const attachmentRevisionRef = useRef(0);
  const pendingImageCountRef = useRef(0);
  const pendingTextFileCountRef = useRef(0);
  const pendingTextFileBytesRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  attachedTextFilesRef.current = attachedTextFiles;

  const insertTextAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setValue((v) => v + (v ? " " : "") + text);
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
    const newVal = before + sep + text + after;
    setValue(newVal);
    setAtQuery(null);
    requestAnimationFrame(() => {
      if (!ta) return;
      const pos = start + sep.length + text.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const { isRecording, isTranscribing, toggle: toggleDictation, cancel: cancelDictation, stop: stopDictation } = useDictation({
    onTranscript: insertTextAtCursor,
    onError: (err) => {
      const msg =
        err === "Microphone not supported in this browser or context"
          ? t("chatInput.dictationNotSupported")
          : err === "Microphone access denied"
          ? t("chatInput.dictationPermissionDenied")
          : err === "No speech detected"
          ? t("chatInput.dictationNoSpeech")
          : err === "Transcription failed"
          ? t("chatInput.dictationFailed")
          : err;
      toast.error(msg);
    },
  });

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus();
    },
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText: insertTextAtCursor,
    addFiles(files: File[]) {
      processFiles(files);
    },
    openContextPanel() {
      setContextOpen(true);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((file) => file.type.startsWith("image/") && file.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) {
      if (files.length > 0) {
        setAttachError(
          remaining === 0
            ? `Maximum of ${MAX_ATTACHED_IMAGES} attached images reached.`
            : `${files.length} image(s) skipped: images up to ${formatAttachmentBytes(MAX_ATTACHED_IMAGE_BYTES)} are supported.`,
        );
      }
      return;
    }
    const revision = attachmentRevisionRef.current;
    pendingImageCountRef.current += imageFiles.length;
    const created: AttachedImage[] = [];
    try {
      const newImages = await Promise.all(
        imageFiles.map(
          (file) =>
            new Promise<AttachedImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                // result is "data:<mime>;base64,<data>"
                const base64 = result.split(",")[1];
                const image = { data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) };
                created.push(image);
                resolve(image);
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      // The composer was cleared/sent while the reads were in flight —
      // drop the batch instead of re-appending stale attachments.
      if (attachmentRevisionRef.current !== revision) {
        newImages.forEach(revokeImagePreview);
        return;
      }
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        return [...prev, ...accepted];
      });
      setAttachError(null);
    } catch {
      // A failed read in the batch must not leak the siblings' blob URLs.
      created.forEach(revokeImagePreview);
      setAttachError("One or more images could not be read. Try a different file.");
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, []);

  const processTextFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_TEXT_FILES - attachedTextFilesRef.current.length - pendingTextFileCountRef.current,
    );
    // In-flight batches reserve their bytes too, so two overlapping drops
    // cannot each fit under the aggregate budget on their own.
    const { accepted: textFiles, tooLarge, overBudget } = selectTextAttachments(files, {
      usedBytes: attachedTextFilesRef.current.reduce((total, file) => total + file.size, 0) + pendingTextFileBytesRef.current,
      usedSlots: attachedTextFilesRef.current.length + pendingTextFileCountRef.current,
    });
    // Report every dropped candidate, not just an entirely rejected batch: a
    // drop of several files can lose some to the budget while accepting others.
    const limitMessage = remaining === 0 && files.length > 0
      ? `Maximum of ${MAX_ATTACHED_TEXT_FILES} text files reached.`
      : describeTextAttachmentSkip({ tooLarge, overBudget });
    if (!textFiles.length) {
      if (files.length > 0) setAttachError(limitMessage ?? `${files.length} file(s) skipped.`);
      return;
    }
    const revision = attachmentRevisionRef.current;
    pendingTextFileCountRef.current += textFiles.length;
    pendingTextFileBytesRef.current += textFiles.reduce((total, file) => total + file.size, 0);
    try {
      const readFiles = await Promise.all(
        textFiles.map(async (file): Promise<AttachedTextFile> => ({
          name: file.name,
          mimeType: file.type,
          content: await file.text(),
          size: file.size,
        })),
      );
      // The composer was cleared/sent while the reads were in flight —
      // drop the batch instead of re-appending stale attachments.
      if (attachmentRevisionRef.current !== revision) return;
      // Binary content cannot be inlined into the prompt: NUL bytes, or
      // U+FFFD replacement characters left by mis-decoded binary (e.g.
      // UTF-16 text read as UTF-8).
      const newFiles = readFiles.filter(
        (file) => !file.content.includes("\u0000") && !file.content.includes("\uFFFD"),
      );
      const skipped = textFiles.length - newFiles.length;
      setAttachedTextFiles((prev) => [
        ...prev,
        ...newFiles.slice(0, Math.max(0, MAX_ATTACHED_TEXT_FILES - prev.length)),
      ]);
      setAttachError(
        limitMessage
          ?? (skipped > 0 ? `${skipped} file(s) skipped: binary or non-text files cannot be attached.` : null),
      );
    } catch {
      setAttachError("One or more files could not be read. Try a different file.");
    } finally {
      pendingTextFileCountRef.current -= textFiles.length;
      pendingTextFileBytesRef.current -= textFiles.reduce((total, file) => total + file.size, 0);
    }
  }, []);

  const processFiles = useCallback((files: File[]) => {
    if (isStreaming) {
      setAttachError("Attachments are disabled while the agent is running.");
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
    void processImageFiles(imageFiles);
    void processTextFiles(otherFiles);
  }, [isStreaming, processImageFiles, processTextFiles]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
    setAttachError(null);
  }, []);

  const removeTextFile = useCallback((index: number) => {
    setAttachedTextFiles((prev) => prev.filter((_, fileIndex) => fileIndex !== index));
    setAttachError(null);
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearTextFiles = useCallback(() => {
    setAttachedTextFiles([]);
  }, []);

  const clearInput = useCallback(() => {
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    clearTextFiles();
    // Invalidate any attachment reads still in flight.
    attachmentRevisionRef.current += 1;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, clearTextFiles, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      files: attachedTextFiles.map(textFileToDraftFile),
    });
  }, [attachedImages, attachedTextFiles, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    // Invalidate any attachment reads still in flight for the old session so
    // they cannot append onto the new session's composer, and drop any stale
    // validation banner along with the old draft.
    attachmentRevisionRef.current += 1;
    setAttachError(null);
    setQueuedDeleteTarget(null);

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        files: attachedTextFilesRef.current.map(textFileToDraftFile),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setValue(draft?.value ?? "");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(draft?.images);
    });
    setAttachedTextFiles(draftFilesToAttachedFiles(draft?.files));
  }, [draftKey]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);
  useEffect(() => {
    return () => {
      // Drop any reads still in flight when the composer goes away entirely
      // (they would otherwise touch state/URLs of a dead component).
      attachmentRevisionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  /** The routes reject an oversized prompt with 413, but the session hook has
   * already shown the optimistic user bubble and Waiting for model by then, and
   * the composer has been cleared. Refuse here instead, keeping text and
   * images so the user can trim the message.
   *
   * The check owns the banner it raises: a dispatch that now fits clears it,
   * because a text-only prompt has no attachment chip whose removal would. */
  const rejectsOversizedPrompt = useCallback((message: string, images: AttachedImage[]): boolean => {
    const error = validateOutgoingPrompt(message, images);
    setAttachError(error);
    return error !== null;
  }, []);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedTextFiles.length) return;
    if (isStreaming) return;
    onAudioUnlock?.();
    const composedMessage = composeMessageWithTextAttachments(msg, attachedTextFiles);
    if (!attachedImages.length && !attachedTextFiles.length && msg.startsWith("/") && onBuiltinCommand) {
      const expansion = expandWebSlashCommand(msg);
      if (expansion.kind === "expand" && rejectsOversizedPrompt(expansion.prompt, attachedImages)) return;
      const sentValue = value;
      const result = await onBuiltinCommand(msg);
      if (result.handled) {
        // The user may have started typing while the command ran; only clear
        // if the composer still holds what was sent.
        if (!result.error && !result.retainInput && valueRef.current === sentValue) clearInput();
        return;
      }
    }
    if (rejectsOversizedPrompt(composedMessage, attachedImages)) return;
    onSend(composedMessage, attachedImages.length ? attachedImages : undefined);
    clearInput();
  }, [value, attachedImages, attachedTextFiles, isStreaming, onBuiltinCommand, onSend, clearInput, onAudioUnlock, rejectsOversizedPrompt]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;
  const historyFlip = useDropdownFlip(historyMenuOpen && inputHistory.length > 0, historyMenuRef, 0.44, 360);
  const slashFlip = useDropdownFlip(slashMenuOpen && slashQuery !== null, slashMenuRef, 0.56, 460);
  const atFlip = useDropdownFlip(atMenuOpen && atQuery !== null, atMenuRef, 0.48, 400);
  const plusFlip = useDropdownFlip(plusMenuOpen, plusMenuRef, 0.44, 320);
  const [dormantSkillNames, setDormantSkillNames] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (slashQuery === null || !cwd) return;
    const controller = new AbortController();
    void fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ skills?: Array<{ name?: string; disableModelInvocation?: boolean }> }> : null)
      .then((data) => {
        if (!data) return;
        setDormantSkillNames(new Set((data.skills ?? []).flatMap((skill) => skill.disableModelInvocation && skill.name ? [skill.name] : [])));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [cwd, slashQuery]);

  const builtinSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => BUILTIN_SLASH_COMMAND_DEFS
      // The /advisor command is linked to Settings → Enable Advisor: hidden
      // from the palette while the advisor is disabled.
      .filter((def) => def.name !== "advisor" || advisorEnabled)
      .map((def) => ({
        name: def.name,
        description: t(def.descriptionKey),
        ...(def.argumentHintKey ? { argumentHint: t(def.argumentHintKey) } : {}),
        source: "builtin" as const,
      })),
    [t, advisorEnabled],
  );

  // Externally reported commands (extension/prompt/skill/ompBuiltin) group
  // below the client built-ins; any name the web UI intercepts itself —
  // whether an omp builtin or a user extension — is dropped so each command
  // appears exactly once and the client interception behavior is unchanged.
  const externalSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => (slashCommands ?? []).flatMap((command): SlashCommandPaletteItem[] => {
      const source = command.source as string;
      if (CLIENT_BUILTIN_COMMAND_NAMES.has(command.name)) return [];
      if (source === "builtin" || source === "ompBuiltin") {
        return [{ name: command.name, description: command.description, source: "ompBuiltin" }];
      }
      return [command];
    }),
    [slashCommands],
  );

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : builtinSlashCommands), ...externalSlashCommands];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() ?? "";
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery);
        if (rankDelta !== 0) return rankDelta;
        const dormancyDelta = Number(isDormantSkillCommand(a, dormantSkillNames)) - Number(isDormantSkillCommand(b, dormantSkillNames));
        if (dormancyDelta !== 0) return dormancyDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || modelCollator.compare(a.name, b.name);
      });
  })();

  const groupedSlashCommands = (() => {
    const groups = new Map<SlashCommandSource, { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }>();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES
      .map((source) => groups.get(source)!)
      .filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel = slashQuery
    ? tn("chatInput.matchCount", filteredSlashCommands.length)
    : tn("chatInput.commandCount", filteredSlashCommands.length);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    // Abort the previous fetch when the cwd changes or the menu closes, so a
    // slow response for an old directory cannot flip the loading state after
    // a newer one has taken over.
    const controller = new AbortController();
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries. Aborts land
        // here too, which is exactly the desired no-op.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        if (fileIndexFetchingRef.current === fetchCwd) {
          fileIndexFetchingRef.current = null;
          setFileIndexLoading(false);
        }
      });
    return () => controller.abort();
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedTextFiles.length) return;
    if (attachedImages.length || attachedTextFiles.length) return;
    onAudioUnlock?.();
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      const commandName = msg.slice(1).split(/\s+/)[0];
      // Same gate as the direct path (useAgentSession refuses /advisor while
      // disabled): queueing must not become a bypass around the toggle.
      if (commandName === "advisor" && !advisorEnabled) {
        toast.error(t("agentSession.advisorDisabled"));
        return;
      }
      // Web commands must be expanded even when queued: the raw slash text
      // would otherwise reach omp as a literal message (its /goal //plan are
      // TUI-only). Action commands (compact/...) keep the raw text so omp's
      // own ACP handlers can run them.
      const expansion = expandWebSlashCommand(msg);
      if (expansion.kind === "expand") {
        if (rejectsOversizedPrompt(expansion.prompt, attachedImages)) return;
        onPromptWithStreamingBehavior(expansion.prompt, streamingBehavior, attachedImages.length ? attachedImages : undefined);
        clearInput();
        return;
      }
      if (expansion.kind === "usage-error") {
        toast.error(t("chatInput.commandUsageTitle"), t("agentSession.commandRequiresArgs", {
          command: expansion.command,
          usage: t(expansion.argumentHintKey),
        }));
        return;
      }
      if (rejectsOversizedPrompt(msg, attachedImages)) return;
      onPromptWithStreamingBehavior(msg, streamingBehavior, attachedImages.length ? attachedImages : undefined);
      clearInput();
      return;
    }
    if (rejectsOversizedPrompt(msg, attachedImages)) return;
    if (mode === "steer" && onSteer) {
      onSteer(msg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, attachedImages.length ? attachedImages : undefined);
    }
    clearInput();
  }, [value, attachedImages, attachedTextFiles, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, t, advisorEnabled, rejectsOversizedPrompt]);
  // A typed, text-only message during a run is a queued follow-up. Keep Stop
  // as the action while the composer is empty or contains attachments.
  const primaryActionQueuesMessage =
    isStreaming
    && Boolean(value.trim())
    && attachedImages.length === 0
    && attachedTextFiles.length === 0
    && Boolean(onFollowUp);

  // ── Queued follow-up bar ────────────────────────────────────────────────
  // omp reports only a queued count over RPC; the texts are tracked in a
  // client-side mirror, so Edit/Delete/Steer act on that mirror through the
  // session hook's helpers.
  const queuedEntries = [
    ...(queuedMessages?.followUp ?? []).map((text) => ({ kind: "follow-up" as const, text })),
    ...(queuedMessages?.steering ?? []).map((text) => ({ kind: "steer" as const, text })),
  ];
  const firstQueued = queuedEntries[0] ?? null;
  const queuedCount = queuedEntries.length;

  const [queueExpanded, setQueueExpanded] = useState(false);
  // Invalidate confirmation if delivery or navigation changes the queue.
  const activeDeleteTarget = queuedDeleteTarget?.draftKey === draftKey
    && queuedDeleteTarget?.queue === queuedMessages ? queuedDeleteTarget : null;

  const handleItemEdit = useCallback((text: string) => {
    onRemoveQueuedMessage?.(text);
    setValue(text);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [onRemoveQueuedMessage]);

  const handleItemDelete = useCallback((text: string) => {
    setQueuedDeleteTarget({ text, draftKey, queue: queuedMessages });
  }, [draftKey, queuedMessages]);

  const handleItemSteer = useCallback((entry: { kind: "follow-up" | "steer"; text: string }) => {
    if (entry.kind === "follow-up") {
      onPromoteQueuedToSteer?.(entry.text);
    }
  }, [onPromoteQueuedToSteer]);

  const handleQueuedEdit = useCallback(() => {
    if (!firstQueued) return;
    handleItemEdit(firstQueued.text);
  }, [firstQueued, handleItemEdit]);

  const handleQueuedDelete = useCallback(() => {
    if (!firstQueued) return;
    handleItemDelete(firstQueued.text);
  }, [firstQueued, handleItemDelete]);

  const handleQueuedSteer = useCallback(() => {
    if (!firstQueued) return;
    handleItemSteer(firstQueued);
  }, [firstQueued, handleItemSteer]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }
      if (isRecording || isTranscribing) {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelDictation();
          return;
        }
        if (isRecording && e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          stopDictation();
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleDictation();
        return;
      }


      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      // Esc minimizes the composer when idle, empty, and no menus open.
      if (e.key === "Escape" && !isComposing && !isStreaming && onMinimize && value.trim().length === 0) {
        e.preventDefault();
        onMinimize();
        return;
      }

      // Soft keyboards rarely offer Shift+Enter; on the mobile breakpoint Enter
      // inserts a newline and the Send button submits.
      if (e.key === "Enter" && !e.shiftKey && !isMobile) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Submit-during-run behavior comes from Settings (Steer current run
          // by default, or Queue follow-up); no in-composer selector.
          const behavior = getSubmitDuringRunBehavior();
          if (behavior === "steer" && onSteer) sendQueued("steer");
          else sendQueued("followup");
        } else {
          handleSend();
        }
      }
    },
    [isMobile, isStreaming, onSteer, onFollowUp, onAbort, onMinimize, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, isRecording, isTranscribing, cancelDictation, stopDictation, toggleDictation]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processFiles(files);
  }, [processFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const [visibleModelKeys, setVisibleModelKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    const refresh = () => setVisibleModelKeys(readVisibleModelKeys());
    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === COMPOSER_MODELS_STORAGE_KEY) refresh();
    };
    refresh();
    window.addEventListener("omp-composer-models-change", refresh);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener("omp-composer-models-change", refresh);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, []);

  const modelOptions: ModelOption[] = React.useMemo(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }))
        .filter((m) => visibleModelKeys === null || visibleModelKeys.has(`${m.provider}:${m.modelId}`))
        .sort((a, b) => compareModelOptions(modelCollator, a, b));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort((a, b) => compareModelOptions(modelCollator, a, b));
  }, [modelList, modelNames, model?.provider, visibleModelKeys, modelCollator]);

  const filteredModelOptions = React.useMemo(
    () => filterModelOptions(modelOptions, modelSearchQuery, locale),
    [locale, modelOptions, modelSearchQuery],
  );

  // Grouping for the nested picker lives in ChatInput-model-picker (providers rail + models pane).

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name
        ?? modelNameOverride
        ?? modelNames?.[`${model.provider}:${model.modelId}`]
        ?? model.modelId)
    : null;
  const currentName = displayModelName;
  // A failed load surfaces modelError; only an in-flight load shows the
  // loading chip, so "no models" can only appear after the fetch settled.
  const showModelsLoading = Boolean(modelsLoading) && !modelError;
  const modelSelectorDisabled = isStreaming || (showModelsLoading && modelOptions.length === 0);

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactVerb = compactResult?.reason && compactResult.reason !== "manual"
    ? t("chatInput.compactedWithReason", {
        reason: `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)}`,
      })
    : t("chatInput.compacted");
  const compactResultText = compactResult
    ? t("chatInput.compactResult", {
        verb: compactVerb,
        before: formatTokenCount(compactResult.tokensBefore, locale),
        after: formatTokenCount(compactResult.estimatedTokensAfter, locale),
        saved: formatTokenCount(compactSavedTokens, locale),
      })
    : null;
  // Composer context ring: live totals, falling back to the session snapshot.
  const ringCtx = contextUsage ?? sessionStats?.contextUsage ?? null;
  const ringPct = ringCtx?.percent ?? null;
  const ringTone = ringPct !== null && ringPct > 90
    ? "var(--status-error)"
    : ringPct !== null && ringPct > 70
      ? "var(--status-warning)"
      : "var(--text-muted)";
  const ringTitle = ringCtx?.contextWindow
    ? [
        ringPct !== null ? formatPercent(ringPct) : null,
        ringCtx.tokens !== null && ringCtx.tokens !== undefined
          ? `${formatCompactNumber(ringCtx.tokens)} / ${formatCompactNumber(ringCtx.contextWindow)}`
          : formatCompactNumber(ringCtx.contextWindow),
        t("chatInput.compactContext"),
      ].filter(Boolean).join(" · ")
    : t("chatInput.compactContext");
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const thinkingLevelOptions = React.useMemo(
    () => selectableThinkingLevels(availableThinkingLevels),
    [availableThinkingLevels],
  );
  // A run starting mid-interaction must not leave the reasoning menu
  // open: the level only applies to the next prompt, and the trigger is
  // disabled while streaming.
  useEffect(() => {
    if (isStreaming) setThinkingDropdownOpen(false);
  }, [isStreaming]);

  useEffect(() => {
    if (!modelDropdownOpen) {
      setModelSearchQuery("");
      return;
    }
    requestAnimationFrame(() => modelSearchInputRef.current?.focus());
  }, [modelDropdownOpen]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
      if (contextWrapRef.current && !contextWrapRef.current.contains(e.target as Node)) {
        setContextOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
         padding: "0 16px calc(8px + env(safe-area-inset-bottom))",
      }}
    >
      <ConfirmDialog
        open={activeDeleteTarget !== null}
        onOpenChange={(open) => { if (!open) setQueuedDeleteTarget(null); }}
        title={t("chatInput.queuedDeleteTitle")}
        description={(
          <>
            {t("chatInput.queuedDeleteConfirmBody")}
            <span style={{ display: "block", marginTop: 12, maxHeight: 180, overflowY: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {activeDeleteTarget?.text}
            </span>
          </>
        )}
        confirmLabel={t("chatInput.queuedDelete")}
        cancelLabel={t("chatInput.cancel")}
        danger
        onConfirm={() => {
          if (!activeDeleteTarget) return;
          setQueuedDeleteTarget(null);
          onRemoveQueuedMessage?.(activeDeleteTarget.text);
        }}
      />
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        // Accept every file type: the handler below reads any non-image file
        // as text (rejecting binary content), so restricting the picker would
        // only hide files the app can attach (code, config, logs, ...).
        accept="*/*"
        multiple
        disabled={isStreaming}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ComposerModeStatus goal={activeGoal} plan={activePlan} />
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-warning) 25%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-warning)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("chatInput.retrying", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
            {onAbortRetry && (
              <button
                type="button"
                onClick={onAbortRetry}
                title="Stop the automatic retry and leave the failed turn as-is"
                style={{
                  marginLeft: "auto",
                  padding: "3px 9px",
                  fontSize: 11,
                  color: "var(--status-warning)",
                  background: "transparent",
                  border: "1px solid color-mix(in srgb, var(--status-warning) 45%, transparent)",
                  borderRadius: 6,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--status-warning) 12%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Abort retry
              </button>
            )}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-success) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-success) 24%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-success)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* Image previews */}
        {attachError && (
          <div role="alert" style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-error) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-error)",
          }}>
            {attachError}
          </div>
        )}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  title="Remove image"
                  aria-label="Remove image"
                  style={{
                    position: "absolute", top: -5, right: -5,
                    width: 24, height: 24, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {attachedTextFiles.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedTextFiles.map((file, i) => (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  maxWidth: 260, height: 30,
                  padding: "0 6px 0 9px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-panel)",
                  fontSize: 12,
                  color: "var(--text)",
                }}
              >
                <span style={{ flexShrink: 0, display: "flex", color: "var(--text-muted)" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                <span
                  title={file.name}
                  style={{
                    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)", fontSize: 11.5,
                  }}
                >
                  {file.name}
                </span>
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
                  {file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`}
                </span>
                <button
                  onClick={() => removeTextFile(i)}
                  title="Remove file"
                  aria-label="Remove file"
                  style={{
                    flexShrink: 0, width: 18, height: 18,
                    borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "transparent", border: "none",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative" }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              className="dropdown-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                zIndex: 120,
                display: "flex",
                flexDirection: "column",
                ...menuDropStyle(historyFlip.placement, historyFlip.maxHeight),
              }}
            >
              <div
                title={t("chatInput.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  maxHeight: historyFlip.maxHeight !== null
                    ? `${Math.max(0, historyFlip.maxHeight - 31)}px`
                    : "calc(min(44vh, 360px) - 31px)",
                  overflowY: "auto",
                  padding: 4,
                }}
              >
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              ref={slashMenuRef}
              className="dropdown-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                zIndex: 120,
                display: "flex",
                flexDirection: "column",
                ...menuDropStyle(slashFlip.placement, slashFlip.maxHeight),
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                <span>{slashCommandsLoading ? t("chatInput.loadingCommands") : t("chatInput.slashCommandsHeader", { countLabel: slashCommandCountLabel })}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{t("chatInput.tabEnterHint")}</span>
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  maxHeight: slashFlip.maxHeight !== null
                    ? `${Math.max(0, slashFlip.maxHeight - 34)}px`
                    : "calc(min(56vh, 460px) - 34px)",
                  overflowY: "auto",
                  padding: 10,
                }}
              >
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                    {t("chatInput.noCommandsFound")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, dormantSkillNames);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: dormant ? "var(--text-dim)" : "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}>
                                /{command.name}
                                {command.argumentHint && (
                                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>{command.argumentHint}</span>
                                )}
                                {dormant && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>{t("chatInput.dormant")}</span>}
                              </span>
                              {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                  {command.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
            const matchCountLabel = tn("chatInput.matchCount", atMatches.length);
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
              ? ` · ${atQuery.query ? t("chatInput.searchingAllFiles") : t("chatInput.indexTruncated")}`
              : "";
            return (
              <div
                ref={atMenuRef}
                className="dropdown-surface"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  zIndex: 120,
                  display: "flex",
                  flexDirection: "column",
                  ...menuDropStyle(atFlip.placement, atFlip.maxHeight),
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <span>
                    {indexLoading
                      ? t("chatInput.loadingFiles")
                      : `${t("chatInput.filesHeader", { countLabel: matchCountLabel })}${truncatedHint}`}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{t("chatInput.tabEnterHint")}</span>
                </div>
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    maxHeight: atFlip.maxHeight !== null
                      ? `${Math.max(0, atFlip.maxHeight - 34)}px`
                      : "calc(min(48vh, 400px) - 34px)",
                    overflowY: "auto",
                    padding: 4,
                  }}
                >
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                      {needsServerSearch && !serverResultInUse ? t("chatInput.searching") : t("chatInput.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
        {/* Queued prompts panel / bar — attached to composer's top edge.
            When 1 item: compact single row. When multiple items: compact row with expand toggle, or full list when expanded. */}
        {queuedCount > 0 && (
          <div
            aria-label={t("chatInput.queuedPrompts")}
            style={{
              border: "1px solid var(--border)",
              borderBottom: "none",
              borderRadius: "var(--radius-card) var(--radius-card) 0 0",
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            {queuedCount === 1 ? (
              <div style={{
                padding: "5px 8px 5px 12px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}>
                <span style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                }}>
                  {firstQueued?.kind === "steer" ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
                </span>
                <span
                  title={firstQueued?.text}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  {firstQueued?.text}
                </span>
                <QueuedActionButton onClick={handleQueuedEdit} title={t("chatInput.queuedEditTitle")}>
                  {t("chatInput.queuedEdit")}
                </QueuedActionButton>
                <QueuedActionButton onClick={handleQueuedDelete} title={t("chatInput.queuedDeleteTitle")}>
                  {t("chatInput.queuedDelete")}
                </QueuedActionButton>
                {firstQueued?.kind === "follow-up" && (
                  <QueuedActionButton onClick={handleQueuedSteer} title={t("chatInput.queuedSteerTitle")} accent>
                    {t("chatInput.queuedSteerAction")}
                  </QueuedActionButton>
                )}
              </div>
            ) : (
              <div>
                <div style={{
                  padding: "5px 8px 5px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  borderBottom: queueExpanded ? "1px solid var(--border)" : "none",
                }}>
                  <button
                    type="button"
                    onClick={() => setQueueExpanded((prev) => !prev)}
                    aria-expanded={queueExpanded}
                    title={queueExpanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      minWidth: 0,
                      flex: 1,
                      textAlign: "left",
                    }}
                  >
                    <ChevronDown
                      size={13}
                      strokeWidth={2}
                      style={{
                        transform: queueExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                        transition: "transform var(--dur-fast) var(--ease-out-warm)",
                        flexShrink: 0,
                      }}
                      aria-hidden
                    />
                    <span>{t("chatInput.queuedPrompts")}</span>
                    <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>({queuedCount})</span>
                    {!queueExpanded && firstQueued && (
                      <span
                        style={{
                          marginLeft: 4,
                          color: "var(--text-dim)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 11,
                          fontWeight: 400,
                          textTransform: "none",
                        }}
                      >
                        {firstQueued.kind === "steer" ? `[${t("chatInput.queuedSteer")}] ` : ""}{firstQueued.text}
                      </span>
                    )}
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => setQueueExpanded((prev) => !prev)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: "2px 6px",
                        cursor: "pointer",
                        color: "var(--text-dim)",
                        fontSize: 11,
                      }}
                    >
                      {queueExpanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
                    </button>
                  </div>
                </div>
                {queueExpanded && (
                  <div style={{
                    maxHeight: 180,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    background: "var(--bg-subtle)",
                    padding: "4px 0",
                  }}>
                    {queuedEntries.map((entry, idx) => (
                      <div
                        key={`${entry.kind}:${idx}:${entry.text}`}
                        style={{
                          padding: "4px 8px 4px 12px",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          background: "var(--bg-panel)",
                          fontSize: 12,
                        }}
                      >
                        <span style={{
                          flexShrink: 0,
                          fontSize: 9.5,
                          fontWeight: 600,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          padding: "1px 4px",
                          borderRadius: 4,
                          background: entry.kind === "steer" ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--bg)",
                          border: `1px solid ${entry.kind === "steer" ? "var(--accent)" : "var(--border)"}`,
                          color: entry.kind === "steer" ? "var(--accent)" : "var(--text-muted)",
                        }}>
                          {entry.kind === "steer" ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
                        </span>
                        <span
                          title={entry.text}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--text)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 11.5,
                          }}
                        >
                          {entry.text}
                        </span>
                        <QueuedActionButton onClick={() => handleItemEdit(entry.text)} title={t("chatInput.queuedEditTitle")}>
                          {t("chatInput.queuedEdit")}
                        </QueuedActionButton>
                        <QueuedActionButton onClick={() => handleItemDelete(entry.text)} title={t("chatInput.queuedDeleteTitle")}>
                          {t("chatInput.queuedDelete")}
                        </QueuedActionButton>
                        {entry.kind === "follow-up" && (
                          <QueuedActionButton onClick={() => handleItemSteer(entry)} title={t("chatInput.queuedSteerTitle")} accent>
                            {t("chatInput.queuedSteerAction")}
                          </QueuedActionButton>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Live agent status bar — attached to composer's top edge */}
        {statusText && (
          <div
            role="status"
            aria-live="polite"
            style={{
              border: `1px solid ${bashMode ? "var(--tool-bg)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderBottom: "none",
              borderRadius: queuedCount > 0 ? 0 : "var(--radius-card) var(--radius-card) 0 0",
              background: "var(--bg-panel)",
              padding: "6px 14px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            <span
              aria-hidden
              className="live-status-dot live-pulse inline-block h-2 w-2 shrink-0 rounded-full bg-accent"
            />
            <span>{statusText}</span>
          </div>
        )}
          <div
            className="chat-input-shell"
            style={{
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: (queuedCount > 0 || Boolean(statusText)) ? "0 0 var(--radius-card) var(--radius-card)" : "var(--radius-card)",
              padding: "12px 12px 10px 14px",
              boxShadow: "var(--shadow-card)",
              transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
            } as React.CSSProperties}
          >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={t("chatInput.placeholder")}
            rows={1}
            style={{
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-user-font-size)",
              lineHeight: "var(--chat-line-height)",
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          {/* Toolbar: plus menu · model · reasoning · fast · compact · send/queue/stop */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid color-mix(in srgb, var(--border) 62%, transparent)",
            flexWrap: isMobile ? "wrap" : "nowrap",
          }}>
            {/* Plus menu — attachment · tools submenu · advisor submenu */}
            <div ref={plusMenuRef} style={{ position: "relative", flexShrink: 0 }}>
              <button
                onClick={() => setPlusMenuOpen((v) => !v)}
                title={t("chatInput.plusMenu")}
                aria-label={t("chatInput.plusMenu")}
                aria-expanded={plusMenuOpen}
                aria-haspopup="menu"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28, height: 28, padding: 0,
                  background: plusMenuOpen ? "var(--bg-hover)" : "none",
                  border: "none",
                  borderRadius: 7,
                  color: plusMenuOpen ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = plusMenuOpen ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = plusMenuOpen ? "var(--text)" : "var(--text-muted)"; }}
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
              </button>
              {plusMenuOpen && (
                <div
                  className="picker-panel"
                  role="menu"
                  aria-label={t("chatInput.plusMenu")}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPlusMenuOpen(false); } }}
                  style={{
                    position: "absolute", left: 0,
                    zIndex: 100, width: 230, maxWidth: "calc(100vw - 32px)",
                    overflowY: "auto",
                    ...menuDropStyle(plusFlip.placement, plusFlip.maxHeight),
                  }}
                >
                  <div className="picker-panel-header">
                    <Plus size={12} strokeWidth={2} style={{ color: "var(--text-muted)", flexShrink: 0 }} aria-hidden="true" />
                    <span className="picker-panel-title">{t("chatInput.plusMenu")}</span>
                  </div>
                  <button
                    role="menuitem"
                    onClick={() => { setPlusMenuOpen(false); fileInputRef.current?.click(); }}
                    disabled={isStreaming}
                    title={t("chatInput.attachFile")}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "7px 10px", border: 0, borderRadius: 5,
                      background: "transparent", color: isStreaming ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer", fontSize: 12, textAlign: "left",
                    }}
                  >
                    <Paperclip size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
                    <span style={{ flex: 1 }}>{t("chatInput.attachFile")}</span>
                  </button>
                  {onToolPresetChange && (
                    <>
                      <button
                        role="menuitem"
                        aria-expanded={plusExpanded === "tools"}
                        onClick={() => setPlusExpanded((v) => (v === "tools" ? null : "tools"))}
                        title={t("chatInput.changeToolPresetTitle", { preset: toolPreset ?? "full" })}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, width: "100%",
                          padding: "7px 10px", border: 0, borderRadius: 5,
                          background: plusExpanded === "tools" ? "var(--bg-selected)" : "transparent",
                          color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left",
                        }}
                      >
                        <Wrench size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
                        <span style={{ flex: 1 }}>{t("chatInput.toolPresetLabel")}</span>
                        <span style={{ color: "var(--text-dim)", textTransform: "capitalize" }}>{toolPreset ?? "full"}</span>
                        <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7, transform: plusExpanded === "tools" ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
                      </button>
                      {plusExpanded === "tools" && TOOL_PRESET_OPTIONS.map((opt) => {
                        const isActive = (toolPreset ?? "full") === opt.value;
                        return (
                          <button
                            className="picker-row"
                            role="menuitemradio"
                            aria-checked={isActive}
                            data-active={isActive}
                            key={opt.value}
                            title={t(opt.descriptionKey)}
                            onClick={() => { setPlusMenuOpen(false); if (!isActive) onToolPresetChange(opt.value); }}
                            style={{ paddingLeft: 30 }}
                          >
                            <span className="picker-check">
                              {isActive && <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>}
                            </span>
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "capitalize" }}>{opt.value}</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                  {onAdvisorChange && (
                    <>
                      <button
                        role="menuitem"
                        aria-expanded={plusExpanded === "advisor"}
                        onClick={() => setPlusExpanded((v) => (v === "advisor" ? null : "advisor"))}
                        title={advisorEnabled ? t("chatInput.advisorDisableTitle", { model: advisorModel?.name ?? t("messageView.advisorLabel"), reasoning: advisorModel?.reasoning ?? t("chatInput.advisorReasoningDefault") }) : t("chatInput.advisorEnableTitle")}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, width: "100%",
                          padding: "7px 10px", border: 0, borderRadius: 5,
                          background: plusExpanded === "advisor" ? "var(--bg-selected)" : "transparent",
                          color: advisorEnabled ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left",
                        }}
                      >
                        <Sparkles size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
                        <span style={{ flex: 1 }}>{t("messageView.advisorLabel")}</span>
                        <span style={{ color: "var(--text-dim)" }}>{advisorEnabled ? t("chatInput.plusOn") : t("chatInput.plusOff")}</span>
                        <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7, transform: plusExpanded === "advisor" ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
                      </button>
                      {plusExpanded === "advisor" && (
                        <button
                          className="picker-row"
                          role="menuitem"
                          onClick={() => { setPlusMenuOpen(false); onAdvisorChange(!advisorEnabled); }}
                          title={advisorEnabled ? t("chatInput.advisorDisableTitle", { model: advisorModel?.name ?? t("messageView.advisorLabel"), reasoning: advisorModel?.reasoning ?? t("chatInput.advisorReasoningDefault") }) : t("chatInput.advisorEnableTitle")}
                          style={{ paddingLeft: 30 }}
                        >
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {advisorEnabled ? t("chatInput.advisorDisableTitle", { model: advisorModel?.name ?? t("messageView.advisorLabel"), reasoning: advisorModel?.reasoning ?? t("chatInput.advisorReasoningDefault") }) : t("chatInput.advisorEnableTitle")}
                          </span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            {/* Model selector — compact text button with dropdown */}
            {(modelOptions.length > 0 || currentName || modelError || showModelsLoading) && onModelChange && (
              <div ref={dropdownRef} style={{ position: "relative", minWidth: 0 }}>
                <button
                  onClick={() => setModelDropdownOpen((v) => !v)}
                  disabled={modelSelectorDisabled}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28,
                    maxWidth: 190,
                    padding: "0 8px",
                    overflow: "hidden",
                    background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    color: "var(--text-muted)",
                    cursor: modelSelectorDisabled ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: modelSelectorDisabled ? 0.5 : 1,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                  title={modelOptions.length > 0
                    ? t("chatInput.changeModel")
                    : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
                  aria-expanded={modelDropdownOpen}
                  aria-haspopup="dialog"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                    <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                    <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                    <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {currentName ?? (modelOptions.length > 0
                      ? t("chatInput.selectModel")
                      : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noModels"))}
                  </span>
                  <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7, transform: modelDropdownOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
                </button>
                {modelDropdownOpen && (
                  <div
                    ref={modelDropdownPanelRef}
                    className="picker-panel"
                    style={{
                      position: isMobile ? "fixed" : "absolute",
                      bottom: isMobile ? 8 : "calc(100% + 6px)",
                      ...(isMobile
                        ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                        : { left: 0, width: "min(360px, calc(100vw - 32px))" }),
                      zIndex: 500,
                      display: "flex",
                      flexDirection: "column",
                      height: isMobile ? undefined : "min(360px, calc(100dvh - 32px))",
                      maxHeight: isMobile ? "calc(100dvh - 32px)" : undefined,
                    }}
                  >
                      <div className="picker-panel-header">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)" }}>
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                          <rect x="9" y="9" width="6" height="6" />
                        </svg>
                        <span className="picker-panel-title">{t("chatInput.modelsLabel")}</span>
                        <span className="picker-panel-count">{modelOptions.length}</span>
                      </div>
                      <ModelPickerPanel
                        modelOptions={modelOptions}
                        filteredModelOptions={filteredModelOptions}
                        currentModel={model}
                        modelSearchQuery={modelSearchQuery}
                        onSearchQueryChange={setModelSearchQuery}
                        searchInputRef={modelSearchInputRef}
                        showModelsLoading={showModelsLoading}
                        isMobile={isMobile}
                        onSelectModel={(provider, modelId) => {
                          setModelDropdownOpen(false);
                          if (provider !== model?.provider || modelId !== model?.modelId || isAutoModelSelection) {
                            onModelChange(provider, modelId);
                          }
                        }}
                        onClose={() => setModelDropdownOpen(false)}
                        onOpenProviders={onOpenProviders ? () => {
                          setModelDropdownOpen(false);
                          onOpenProviders();
                        } : undefined}
                      />
                    </div>
                )}
              </div>
            )}

            {/* Thinking selector — compact, expressive, and consistent with models */}
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title={t("chatInput.changeReasoningTitle", { level: thinkingDisplayLabel })}
                  aria-label={`${t("chatInput.changeReasoning")}: ${thinkingDisplayLabel}`}
                  aria-expanded={thinkingDropdownOpen}
                  aria-haspopup="menu"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28, padding: "0 8px", background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none", borderRadius: 7, color: "var(--text-muted)", cursor: isStreaming ? "not-allowed" : "pointer",
                    opacity: isStreaming ? 0.5 : 1, fontSize: 12,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { if (!isStreaming) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" /><line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap", textTransform: "capitalize" }}>{thinkingDisplayLabel}</span>
                  <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7, transform: thinkingDropdownOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
                </button>
                {thinkingDropdownOpen && (
                  <div
                    className="picker-panel"
                    role="menu"
                    style={{
                      position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                      zIndex: 100, width: 190, maxWidth: "calc(100vw - 32px)",
                    }}
                  >
                    <div className="picker-panel-header">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)" }}>
                        <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                        <line x1="7" y1="18" x2="12" y2="18" />
                      </svg>
                      <span className="picker-panel-title">{t("chatInput.reasoningLabel")}</span>
                      <span className="picker-panel-count">{thinkingLevelOptions.length}</span>
                    </div>
                    <div className="picker-thinking-cards">
                      {thinkingLevelOptions.map((lvl) => {
                        const isActive = (thinkingLevel ?? "auto") === lvl;
                        const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                        const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                        return (
                          <button
                            className="picker-thinking-card"
                            data-active={isActive}
                            role="menuitemradio"
                            aria-checked={isActive}
                            key={lvl}
                            onClick={() => { setThinkingDropdownOpen(false); if (!isActive && !isStreaming) onThinkingLevelChange(lvl); }}
                          >
                            <span className="picker-check">
                              {isActive && <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>}
                            </span>
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "capitalize" }}>{displayLabel}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="picker-panel-footer">
                      <span>{t("chatInput.appliesNextPrompt")}</span>
                      <span style={{ fontWeight: 600, color: "var(--text-muted)", textTransform: "capitalize" }}>{thinkingDisplayLabel}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Fast toggle — only for models that support fast mode. Stays
                visible while the agent runs (disabled) so it does not look
                like fast mode was reset; the toggle affects the family tier
                for the next prompt. */}
            {fastModeSupported && onFastModeChange && (
              <button
                type="button"
                onClick={() => { if (isStreaming) return; onFastModeChange(!fastModeEnabled); }}
                disabled={isStreaming}
                title={fastModeEnabled && fastModeActive === false ? "Fast mode is enabled but inactive for this model" : `Turn OMP Fast mode ${fastModeEnabled ? "off" : "on"} for this model`}
                aria-pressed={fastModeEnabled}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  height: 28,
                  padding: "0 8px",
                  background: fastModeEnabled ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderRadius: 7,
                  color: fastModeEnabled && fastModeActive === false ? "var(--status-warning)" : fastModeEnabled ? "var(--accent)" : "var(--text-muted)",
                  cursor: isStreaming ? "not-allowed" : "pointer",
                  opacity: isStreaming ? 0.5 : 1,
                  fontSize: 12,
                  fontWeight: 600,
                  transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {t("chatInput.fastLabel")}
              </button>
            )}

            <div style={{ flex: 1 }} />

            {/* Advisor activity — thunder while the advisor model reviews this run */}
            {advisorActive && (
              <span
                title={t("chatInput.advisorReviewingTitle", {
                  model: advisorModel?.name ?? t("messageView.advisorLabel"),
                  reasoning: advisorModel?.reasoning ?? t("chatInput.advisorReasoningDefault"),
                })}
                aria-label={t("chatInput.advisorReviewingTitle", {
                  model: advisorModel?.name ?? t("messageView.advisorLabel"),
                  reasoning: advisorModel?.reasoning ?? t("chatInput.advisorReasoningDefault"),
                })}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, flexShrink: 0, color: "var(--accent)" }}
              >
                <Zap size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />
              </span>
            )}

            {/* Context ring: usage gauge opening the session context popover */}
            {onCompact && (
              <div ref={contextWrapRef} style={{ position: "relative", flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => setContextOpen((open) => !open)}
                  title={ringTitle}
                  aria-label={t("composerContext.title")}
                  aria-expanded={contextOpen}
                  aria-haspopup="dialog"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 28, height: 28, padding: 0,
                    background: contextOpen ? "var(--bg-hover)" : "none", border: "none",
                    borderRadius: 7,
                    color: isCompacting ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = contextOpen ? "var(--bg-hover)" : "none"; }}
                >
                  {isCompacting ? (
                    <Loader2 size={14} strokeWidth={2} aria-hidden="true" style={{ animation: "spin 0.8s linear infinite" }} />
                  ) : (
                    <span style={{ position: "relative", width: 20, height: 20, display: "inline-flex" }} aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 20 20">
                        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" strokeWidth="2.5" />
                        {ringPct !== null && (
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            fill="none"
                            stroke={ringTone}
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeDasharray={2 * Math.PI * 8}
                            strokeDashoffset={2 * Math.PI * 8 * (1 - Math.min(100, Math.max(0, ringPct)) / 100)}
                            transform="rotate(-90 10 10)"
                            style={{ transition: "stroke-dashoffset var(--dur-med) var(--ease-out-warm)" }}
                          />
                        )}
                      </svg>
                      {ringPct !== null && (
                        <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 700, fontFamily: "var(--font-mono)", color: ringTone }}>
                          {Math.round(ringPct)}
                        </span>
                      )}
                    </span>
                  )}
                </button>
                {contextOpen && (
                  <div
                    role="dialog"
                    aria-label={t("composerContext.title")}
                    className="picker-panel"
                    style={{
                      position: isMobile ? "fixed" : "absolute",
                      bottom: isMobile ? 8 : "calc(100% + 8px)",
                      ...(isMobile
                        ? { left: 8, right: 8 }
                        : { right: 0, width: 360, maxWidth: "min(360px, calc(100vw - 32px))" }),
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-card)",
                      boxShadow: "var(--shadow-pop)",
                      zIndex: 60,
                      padding: 12,
                      maxHeight: isMobile ? "calc(100dvh - 32px)" : "min(50vh, 380px)",
                      overflowY: "auto",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("composerContext.title")}</span>
                      {ringPct !== null && (
                        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700, color: ringTone, fontVariantNumeric: "tabular-nums" }}>
                          {formatPercent(ringPct)}
                        </span>
                      )}
                    </div>
                    <ContextDetailPanel
                      sessionStats={sessionStats}
                      contextUsage={contextUsage}
                      modelCapacity={modelCapacity}
                      generationSpeed={generationSpeed}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (isCompacting) onAbortCompaction?.();
                        else onCompact?.();
                        setContextOpen(false);
                      }}
                      disabled={isStreaming && !isCompacting}
                      title={isCompacting ? t("chatInput.stopCompaction") : t("chatInput.compactContext")}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        width: "100%", boxSizing: "border-box", height: 30, marginTop: 10, padding: "0 12px",
                        background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                        color: isCompacting ? "var(--accent)" : "var(--text)",
                        cursor: isStreaming && !isCompacting ? "not-allowed" : "pointer",
                        opacity: isStreaming && !isCompacting ? 0.5 : 1,
                        fontSize: 12, fontWeight: 600,
                        transition: "background var(--dur-fast) var(--ease-out-warm)",
                      }}
                      onMouseEnter={(e) => { if (!(isStreaming && !isCompacting)) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-subtle)"; }}
                    >
                      {isCompacting ? (
                        <Loader2 size={13} strokeWidth={2} aria-hidden="true" style={{ animation: "spin 0.8s linear infinite" }} />
                      ) : (
                        <Shrink size={13} strokeWidth={2} aria-hidden="true" />
                      )}
                      {isCompacting ? t("chatInput.stopCompaction") : t("chatInput.compactContext")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Dictation */}
            <button
              type="button"
              onClick={toggleDictation}
              disabled={isTranscribing}
              title={isRecording ? t("chatInput.stopDictation") : isTranscribing ? t("chatInput.transcribing") : t("chatInput.startDictation")}
              aria-label={isRecording ? t("chatInput.stopDictation") : isTranscribing ? t("chatInput.transcribing") : t("chatInput.startDictation")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, padding: 0,
                background: isRecording ? "var(--danger-subtle, rgba(239, 68, 68, 0.15))" : "none",
                border: isRecording ? "1px solid var(--danger, #ef4444)" : "none",
                borderRadius: 7,
                color: isRecording ? "var(--danger, #ef4444)" : isTranscribing ? "var(--accent)" : "var(--text-muted)",
                cursor: isTranscribing ? "wait" : "pointer",
                transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { if (!isRecording && !isTranscribing) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = isRecording ? "var(--danger-subtle, rgba(239, 68, 68, 0.15))" : "none"; }}
            >
              {isTranscribing ? (
                <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
              ) : (
                <Mic size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            {/* Primary action: Send (idle) / Queue (typed while running) / Stop (running) */}
            {primaryActionQueuesMessage ? (
              <button
                type="button"
                onClick={() => sendQueued("followup")}
                title={t("chatInput.queueMessage")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: 28,
                  padding: "0 14px",
                  background: "var(--accent-strong)",
                  border: "none",
                  borderRadius: 8,
                  color: "var(--on-accent)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <ListChecks size={13} strokeWidth={2} aria-hidden="true" />
                {t("chatInput.queue")}
              </button>
            ) : isStreaming ? (
              <button
                type="button"
                onClick={isCompacting ? onAbortCompaction : onAbort}
                title={t("chatInput.stopAgent")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: 28,
                  padding: "0 14px",
                  background: "var(--accent-strong)",
                  border: "none",
                  borderRadius: 8,
                  color: "var(--on-accent)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("chatInput.stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!value.trim() && !attachedImages.length && !attachedTextFiles.length}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: 28,
                  padding: "0 14px",
                  background: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "var(--accent-strong)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 8,
                  color: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "var(--on-accent)" : "var(--text-dim)",
                  cursor: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "pointer" : "not-allowed",
                  fontSize: 12,
                  fontWeight: 600,
                  boxShadow: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "var(--shadow-card)" : "none",
                  transition: "background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {t("chatInput.send")}
              </button>
            )}
          </div>
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
            {bashExcluded ? t("chatInput.shellLocal") : t("chatInput.shellToModel")}
          </div>
        )}


      </div>
    </div>
  );
}));
