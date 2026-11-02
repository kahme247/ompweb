import { useCallback, type RefObject } from "react";
import type { BuiltinSlashCommandResult, PromptSubmissionResult } from "@/hooks/useAgentSession";
import { toastBtwError } from "@/hooks/useBtw";
import { toast } from "@/components/ui/toast";
import { recoverDraft } from "@/lib/draft-store";
import { expandWebSlashCommand } from "@/lib/web-slash-commands";
import { composeMessageWithTextAttachments } from "@/lib/chat-attachments";
import { validateOutgoingPrompt } from "@/lib/image-attachments";
import { useI18n } from "@/lib/i18n";
import { imageToDraftImage, type AttachedImage, type AttachedTextFile } from "./ChatInput-draft-attachments";

/** Draft state and session callbacks the composer submit path reads.
 *
 * The caller provides the draft text as rendered (`value`) plus refs holding
 * the latest text, images, text files, draft key and edit gate; `clearInput`
 * empties the composer and its stored draft after a dispatch; `setAttachError`
 * shows (or with null clears) the oversized-prompt banner. The `on*` callbacks
 * are the session actions a message is dispatched through. */
export interface ComposerSubmitOptions {
  /** Draft text from render; Send and queue read it unless given override text. */
  value: string;
  /** Latest draft text, compared after a builtin command resolves. */
  valueRef: RefObject<string>;
  /** Latest attached images, sent with the message and kept for recovery. */
  imagesRef: RefObject<AttachedImage[]>;
  /** Latest attached text files, inlined into the message. */
  textFilesRef: RefObject<AttachedTextFile[]>;
  /** Draft a refused message is recovered into. */
  draftKeyRef: RefObject<string | undefined>;
  /** True while submission is refused (e.g. a pending history edit). */
  submissionBlockedRef: RefObject<boolean>;
  isStreaming: boolean;
  advisorEnabled?: boolean;
  clearInput: () => void;
  setAttachError: (error: string | null) => void;
  /** Only a rejected submission is restored; completed/superseded runs must not be replayed. */
  onSend: (message: string, images?: AttachedImage[]) => Promise<PromptSubmissionResult>;
  /** Steer/follow-up callbacks resolve false when omp refused the message. */
  onSteer?: (message: string, images?: AttachedImage[]) => Promise<boolean>;
  onFollowUp?: (message: string, images?: AttachedImage[]) => Promise<boolean>;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => Promise<boolean>;
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
}

/** Composer submit actions: `handleSend` while idle, `sendQueued` to steer or queue a follow-up during a run. */
export interface ComposerSubmit {
  handleSend: (overrideText?: string) => Promise<void>;
  sendQueued: (mode: "steer" | "followup", overrideText?: string) => void;
}

/** Submit path of the chat composer: builtins, `/btw`, web slash expansion, text attachments, oversized-prompt rejection and draft recovery. */
export function useComposerSubmit({
  value,
  valueRef,
  imagesRef: attachedImagesRef,
  textFilesRef: attachedTextFilesRef,
  draftKeyRef,
  submissionBlockedRef,
  isStreaming,
  advisorEnabled,
  clearInput,
  setAttachError,
  onSend,
  onSteer,
  onFollowUp,
  onPromptWithStreamingBehavior,
  onBuiltinCommand,
  onAudioUnlock,
}: ComposerSubmitOptions): ComposerSubmit {
  const { t } = useI18n();

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
  }, [setAttachError]);

  /** Run a client builtin. True once handled; the composer is cleared only on
   * success and only if it still holds what was sent (the user may have
   * started typing or attached files while the command ran). A dictated send
   * passes its text, which the composer holds once the transcript is inserted. */
  const runBuiltinCommand = useCallback(async (msg: string, overrideText?: string): Promise<boolean> => {
    if (submissionBlockedRef.current || !onBuiltinCommand) return false;
    const sentValue = overrideText ?? valueRef.current;
    const sentImages = attachedImagesRef.current;
    const sentTextFiles = attachedTextFilesRef.current;
    const result = await onBuiltinCommand(msg);
    if (!result.handled) return false;
    const composerUnchanged = valueRef.current === sentValue
      && attachedImagesRef.current === sentImages
      && attachedTextFilesRef.current === sentTextFiles;
    if (!submissionBlockedRef.current && !result.error && !result.retainInput && composerUnchanged) clearInput();
    return true;
  }, [onBuiltinCommand, clearInput, submissionBlockedRef, valueRef, attachedImagesRef, attachedTextFilesRef]);

  /** `/btw` asks a side question beside any run: never a prompt, never
   * queued. Attachments cannot ride along, so refuse and keep the draft
   * rather than drop them. False when `msg` is not `/btw`. */
  const sendSideQuestion = useCallback((msg: string, overrideText?: string): boolean => {
    if (!/^\/btw(\s|$)/.test(msg) || !onBuiltinCommand) return false;
    if (attachedImagesRef.current.length || attachedTextFilesRef.current.length) {
      toast.error(t("btw.attachmentsUnsupported"));
      return true;
    }
    runBuiltinCommand(msg, overrideText).catch(toastBtwError);
    return true;
  }, [onBuiltinCommand, runBuiltinCommand, t, attachedImagesRef, attachedTextFilesRef]);

  /** Send while idle: `/btw`, builtins and slash expansion first, then the prompt; a rejected prompt returns to its draft. */
  const handleSend = useCallback(async (overrideText?: string) => {
    const raw = overrideText ?? value;
    const msg = raw.trim();
    if (!msg && !attachedImagesRef.current.length && !attachedTextFilesRef.current.length) return;
    if (submissionBlockedRef.current || isStreaming) return;
    onAudioUnlock?.();
    if (sendSideQuestion(msg, overrideText)) return;
    const composedMessage = composeMessageWithTextAttachments(msg, attachedTextFilesRef.current);
    if (!attachedImagesRef.current.length && !attachedTextFilesRef.current.length && msg.startsWith("/") && onBuiltinCommand) {
      const expansion = expandWebSlashCommand(msg);
      if (expansion.kind === "expand" && rejectsOversizedPrompt(expansion.prompt, attachedImagesRef.current)) return;
      if (await runBuiltinCommand(msg, overrideText)) return;
    }
    if (submissionBlockedRef.current) return;
    if (rejectsOversizedPrompt(composedMessage, attachedImagesRef.current)) return;
    const key = draftKeyRef.current;
    const images = attachedImagesRef.current.length ? attachedImagesRef.current : undefined;
    const recovery = { text: composedMessage, images: images?.map(imageToDraftImage) };
    const pending = onSend(composedMessage, images);
    clearInput();
    try {
      const result = await pending;
      if (result.status === "rejected") {
        const destination = result.recoveryKey ?? key;
        if (destination) recoverDraft(destination, recovery);
      }
    } catch (error) {
      if (key) recoverDraft(key, recovery);
      throw error;
    }
  }, [value, isStreaming, onBuiltinCommand, onSend, clearInput, onAudioUnlock, rejectsOversizedPrompt, runBuiltinCommand, sendSideQuestion, attachedImagesRef, attachedTextFilesRef, draftKeyRef, submissionBlockedRef]);

  /** Queue the composer text as a steer or follow-up while a run is going; a refused message returns to its draft. */
  const sendQueued = useCallback((mode: "steer" | "followup", overrideText?: string) => {
    if (submissionBlockedRef.current) return;
    const raw = overrideText ?? value;
    const msg = raw.trim();
    if (!msg && !attachedImagesRef.current.length && !attachedTextFilesRef.current.length) return;
    if (sendSideQuestion(msg, overrideText)) return;
    const images = attachedImagesRef.current.length ? attachedImagesRef.current : undefined;
    // The queue callbacks resolve false when omp refused the message: it goes
    // back, text and images together, to the draft it was sent from, even if
    // the user has typed or switched sessions since.
    const key = draftKeyRef.current;
    const keptImages = images?.map(imageToDraftImage);
    const recoverOnFailure = (queued: Promise<boolean>, text: string) => {
      void Promise.resolve(queued).then((ok) => {
        if (ok === false && key) recoverDraft(key, { text, images: keptImages });
      });
    };
    const files = attachedTextFilesRef.current;
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
        const prompt = composeMessageWithTextAttachments(expansion.prompt, files);
        if (rejectsOversizedPrompt(prompt, attachedImagesRef.current)) return;
        recoverOnFailure(onPromptWithStreamingBehavior(prompt, streamingBehavior, images), prompt);
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
      const prompt = composeMessageWithTextAttachments(msg, files);
      if (rejectsOversizedPrompt(prompt, attachedImagesRef.current)) return;
      recoverOnFailure(onPromptWithStreamingBehavior(prompt, streamingBehavior, images), prompt);
      clearInput();
      return;
    }
    const composedMessage = composeMessageWithTextAttachments(msg, files);
    if (rejectsOversizedPrompt(composedMessage, attachedImagesRef.current)) return;
    if (mode === "steer" && onSteer) {
      recoverOnFailure(onSteer(composedMessage, images), composedMessage);
    } else if (mode === "followup" && onFollowUp) {
      recoverOnFailure(onFollowUp(composedMessage, images), composedMessage);
    }
    clearInput();
  }, [value, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, t, advisorEnabled, rejectsOversizedPrompt, sendSideQuestion, attachedImagesRef, attachedTextFilesRef, draftKeyRef, submissionBlockedRef]);

  return { handleSend, sendQueued };
}
