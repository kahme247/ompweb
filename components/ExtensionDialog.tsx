"use client";

import { createElement, Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { HtmlFormData } from "@/lib/pi-types";
import type { UiApprovalAnswer, UiDialogRequest, UiDialogValue } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { matchMobileViewport } from "@/hooks/useIsMobile";

// The Other text lives as long as the question: choosing a regular option only
// unchooses it, so the text is still in its row when Other is chosen again.
type AskDraft = { selected: string[]; other: string; otherChosen: boolean };
const EMPTY_ASK_DRAFT: AskDraft = { selected: [], other: "", otherChosen: false };
// Fields that raise the on-screen keyboard: every input but a radio/checkbox.
const TEXT_ENTRY = "input:not([type=radio]):not([type=checkbox]), textarea";

// Keyboard-aware panel height. The on-screen keyboard shrinks the visible
// area, so a panel sized against the layout viewport alone keeps its footer
// (Cancel / Submit) below the keyboard. `dvh` follows the layout viewport —
// the placeholder cap — which older mobile browsers shrink for the keyboard
// too, so this is a backstop rather than a duplicate.
const DEFAULT_PANEL_MAX_HEIGHT = "min(420px, 60dvh)";
// Room the browser chrome and the keyboard accessory bar need above the panel.
const VIEWPORT_BLEED = 12;
// How much shorter the visual viewport must be before we call it a keyboard.
const KEYBOARD_INSET = 120;
// Some mobile browsers open the keyboard without resizing anything we can
// observe; a slow re-check costs nothing while a question is on screen.
const KEYBOARD_POLL_MS = 400;

function readPanelMaxHeight(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const visual = window.visualViewport?.height;
  const height = typeof visual === "number" && visual > 0
    ? Math.min(visual, window.innerHeight)
    : window.innerHeight;
  return height > 0 ? Math.max(180, Math.round(height - VIEWPORT_BLEED)) : undefined;
}

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const viewport = window.visualViewport;
  // Feature-detect the methods too: Safari 13 shipped a bare `visualViewport`.
  if (typeof viewport?.addEventListener !== "function") return () => {};
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/**
 * CSS length px cap for a panel in the composer: the height of the visible
 * area, so the footer stays on screen while the soft keyboard is up. Reads
 * `undefined` when there is no window (SSR, tests) — the CSS default then
 * applies unchanged.
 */
function useViewportMaxHeight(): number | undefined {
  return useSyncExternalStore(subscribeViewport, readPanelMaxHeight, () => undefined);
}

/** Height of the visible area, falling back to the layout viewport. */
function visibleHeight(): number {
  const visual = window.visualViewport?.height;
  return typeof visual === "number" && visual > 0 ? visual : window.innerHeight;
}

/**
 * Per-panel soft-keyboard tracking for a composer-attached request, active
 * only while a text field inside the panel has focus. A panel in the composer
 * is not a modal, so the browser is free to scroll the page when the keyboard
 * opens; this is what keeps the footer (Cancel / Submit) inside the visible
 * area (#236). A focused option or button raises no keyboard, so it must not
 * resize the panel either: that resize made the tap that focused it miss.
 *
 * Two signals, because neither alone is enough: `visualViewport` shrinking is
 * the real keyboard (fingerprint-free), and a coarse pointer means the tap
 * that focused a field will raise one even before the browser has repainted.
 * A slow re-check covers mobile browsers that resize nothing on focus.
 */
function useMobileInputOpen(panelRef: RefObject<HTMLDivElement | null>, attached: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!attached) {
      setOpen(false);
      return;
    }
    let focused = false;
    // Browsers cannot report the keyboard itself. It opens when the visible
    // area drops well below the tallest seen at this width, and closes when
    // the area grows well above its lowest since then. Comparing to
    // `innerHeight` cannot work: with `interactive-widget: resizes-content`
    // (app/index.html) the keyboard shrinks the layout viewport too.
    let width = window.innerWidth;
    let fullHeight = Math.max(visibleHeight(), window.innerHeight);
    // Lowest visible height while the keyboard is up; null while it is down.
    let keyboardLow: number | null = null;
    // `pointerType` of the latest press anywhere: a hybrid laptop's primary
    // pointer is fine, yet a touch tap there still raises a soft keyboard.
    let lastPointer: string | null = null;
    const onPointerDown = (event: PointerEvent) => { lastPointer = event.pointerType; };
    const update = () => {
      const height = visibleHeight();
      const touch = lastPointer ? lastPointer !== "mouse" : touchPointer();
      if (window.innerWidth !== width) {
        // Rotation or a resized window: the old heights mean nothing at the
        // new size. An open keyboard stays open; its collapse is still a rise.
        width = window.innerWidth;
        fullHeight = height;
        if (keyboardLow !== null) keyboardLow = height;
      }
      fullHeight = Math.max(fullHeight, height);
      if (!touch) {
        // No soft keyboard: a window or docked dev tools resizing is not one.
        keyboardLow = null;
      } else if (keyboardLow === null) {
        if (height < fullHeight - KEYBOARD_INSET) keyboardLow = height;
      } else if (height > keyboardLow + KEYBOARD_INSET) {
        keyboardLow = null;
        // Collapsing the keyboard (back button, swipe) keeps the text field
        // focused, and the next tap anywhere would raise it again for a
        // moment. A closed keyboard means the user is done typing.
        if (focused && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      } else {
        keyboardLow = Math.min(keyboardLow, height);
      }
      // A keyboard over the page (no layout resize) shows on any device.
      const overlaid = height < window.innerHeight - KEYBOARD_INSET;
      const isOpen = focused && (touch || overlaid);
      setOpen((current) => (current === isOpen ? current : isOpen));
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      focused = target instanceof Element && target.matches(TEXT_ENTRY) && Boolean(panelRef.current?.contains(target));
      update();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      focused = next instanceof Element && next.matches(TEXT_ENTRY) && Boolean(panelRef.current?.contains(next));
      update();
    };
    update();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    const poll = setInterval(update, KEYBOARD_POLL_MS);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      clearInterval(poll);
    };
  }, [attached, panelRef]);
  return open;
}

/**
 * Whether a composer-attached request should leave focus alone. Touch input
 * means the browser would raise the on-screen keyboard and yank the panel the
 * user has not read yet into view, so the request waits for a tap. The mobile
 * breakpoint covers where pointer media queries do not answer (older mobile
 * browsers, jsdom, a desktop browser's touch emulation); a narrow *desktop*
 * window is deferred too, which is the deliberate trade for never raising a
 * phone keyboard. Exported for the regression tests (#235).
 */
export function shouldDeferAttachedFocus(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return touchPointer() || matchMobileViewport();
}

/** The primary pointer is a finger: `(pointer: fine)` is the repo's test for a
 * mouse/trackpad, the same one `lib/composer-prefs.ts` uses for word
 * completion, so an unanswerable media query never counts as touch. */
function touchPointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(pointer: fine)").matches;
}

const SENSITIVE_PATTERN = /\b(passwords?|passphrases?|secrets?|tokens?|api[_\s-]?keys?|access[_\s-]?tokens?|private[_\s-]?keys?|auth[_\s-]?tokens?|credentials?)\b/i;
const NON_SECRET_METADATA_PATTERN = /\b(token\s+(?:name|count|limit|budget|usage)|max\s+tokens)\b/i;

export function isSensitivePrompt(title?: string, placeholder?: string): boolean {
  const titleText = (title ?? "").trim();
  const placeholderText = (placeholder ?? "").trim();
  const fullText = `${titleText} ${placeholderText}`.trim();
  if (!fullText) return false;
  const strippedTitle = titleText.replace(NON_SECRET_METADATA_PATTERN, "");
  if (SENSITIVE_PATTERN.test(strippedTitle)) return true;
  const strippedFull = fullText.replace(NON_SECRET_METADATA_PATTERN, "");
  return SENSITIVE_PATTERN.test(strippedFull);
}

/** Single-select questions start on their recommended option. */
function initialAskDrafts(request: UiDialogRequest): AskDraft[] {
  if (request.method !== "askDialog") return [];
  return request.args[0].map((question) => {
    const recommended = question.multi || question.recommended === undefined ? undefined : question.options[question.recommended];
    return { selected: recommended ? [recommended.label] : [], other: "", otherChosen: false };
  });
}

function dialogTitle(request: UiDialogRequest, askTitle: string): string {
  switch (request.method) {
    case "askDialog":
    case "formDialog":
      return askTitle;
    case "approve":
      return request.args[0].full.split("\n", 1)[0];
    default:
      return request.args[0];
  }
}

/** omp's approval choices, in its order: this call, the session, each grant, then no. */
function approvalChoices(request: Extract<UiDialogRequest, { method: "approve" }>, allow: string, deny: string): { label: string; value: UiApprovalAnswer }[] {
  const [prompt] = request.args;
  return [
    { label: allow, value: "once" },
    ...(prompt.session ? [{ label: prompt.session, value: "session" as const }] : []),
    ...(prompt.grants ?? []).flatMap((grant) => [
      { label: grant.label, value: { grant: grant.scope, always: false } },
      { label: grant.alwaysLabel, value: { grant: grant.scope, always: true } },
    ]),
    { label: deny, value: "deny" },
  ];
}

// The agent's form markup becomes React elements: these tags render as themselves with only the
// attributes copied below; others contribute just their text, and dropped ones nothing at all.
const FORM_TAGS: Record<string, true> = {
  fieldset: true, legend: true, p: true, label: true, div: true, span: true, section: true, strong: true, em: true, b: true, i: true,
  code: true, small: true, br: true, hr: true, ul: true, ol: true, li: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
  input: true, select: true, option: true, optgroup: true, textarea: true,
};
const DROPPED_TAGS: Record<string, true> = {
  script: true, style: true, template: true, noscript: true, button: true, iframe: true, object: true, embed: true, img: true, svg: true, math: true,
};
const INPUT_TYPES: Record<string, true> = {
  radio: true, checkbox: true, text: true, number: true, range: true, email: true, url: true, tel: true, search: true, date: true, time: true, hidden: true,
};

/** A radio/checkbox group that offers a free-text "Other" answer, as omp's html-form adds one. */
interface OtherGroup { type: string; name: string; required: boolean }
interface FormCtx {
  prefix: string;
  otherLabel: string;
  /** Option element after which a group's Other box is rendered. */
  others: Map<Element, OtherGroup>;
  /** Options of those groups: their `required` moves to the Other box (see syncOtherValidity). */
  grouped: Set<Element>;
  /** Bare radio/checkbox inputs mapped to their `<label for>`, drawn together as one row. */
  rows: Map<Element, Element>;
  adopted: Set<Element>;
}

const choiceType = (element: Element) => {
  const type = element.getAttribute("type")?.toLowerCase();
  return type === "radio" || type === "checkbox" ? type : undefined;
};

// A control named "elements", "querySelectorAll", ... shadows that property on its form, so read the DOM through the prototypes.
const queryAll = <T extends Element>(form: HTMLFormElement, selector: string) => Array.from(Element.prototype.querySelectorAll.call(form, selector)) as T[];

const namedInputs = (form: HTMLFormElement, name: string, type: string) =>
  queryAll<HTMLInputElement>(form, "input").filter((input) => input.name === name && input.type === type);

// Mirrors omp's parser: a named radio/checkbox group of two or more options gets an Other answer
// unless one of its options is already labelled "Other".
function planForm(root: ParentNode, prefix: string, otherLabel: string): FormCtx {
  const ctx: FormCtx = { prefix, otherLabel, others: new Map(), grouped: new Set(), rows: new Map(), adopted: new Set() };
  const labelFor = new Map<string, Element>();
  for (const label of root.querySelectorAll("label[for]")) {
    if (!labelFor.has(label.getAttribute("for")!)) labelFor.set(label.getAttribute("for")!, label);
  }
  const groups = new Map<string, { input: Element; label?: Element }[]>();
  for (const input of root.querySelectorAll("input")) {
    const type = choiceType(input);
    if (!type) continue;
    const wrapper = input.closest("label");
    const id = input.getAttribute("id");
    const label = wrapper ?? (id ? labelFor.get(id) : undefined);
    if (!wrapper && label) {
      ctx.rows.set(input, label);
      ctx.adopted.add(label);
    }
    const name = input.getAttribute("name");
    if (name) {
      const key = `${type}\0${name}`;
      groups.set(key, [...(groups.get(key) ?? []), { input, label }]);
    }
  }
  for (const [key, options] of groups) {
    if (options.length < 2 || options.some(({ label }) => /^\s*other\b/i.test(label?.textContent ?? ""))) continue;
    const [type, name] = key.split("\0");
    const last = options[options.length - 1].input;
    ctx.others.set(ctx.rows.has(last) ? last : last.closest("label") ?? last, { type, name, required: options.some(({ input }) => input.hasAttribute("required")) });
    for (const { input } of options) ctx.grouped.add(input);
  }
  return ctx;
}

/** Whether a required Other-bearing group has an answer: an option, or Other text. */
function syncOtherValidity(form: HTMLFormElement) {
  for (const other of queryAll<HTMLInputElement>(form, "input[data-other]")) {
    const { other: name, otherType: type = "" } = other.dataset;
    const answered = other.value.trim() !== "" || namedInputs(form, name!, type).some((input) => input.checked && !input.disabled);
    other.setCustomValidity(other.dataset.required && !answered ? (type === "checkbox" ? "Select at least one" : "Required") : "");
  }
}

function otherBox({ type, name, required }: OtherGroup, ctx: FormCtx, key: string) {
  return createElement("input", {
    key,
    type: "text",
    "data-other": name,
    "data-other-type": type,
    "data-required": required || undefined,
    "aria-label": ctx.otherLabel,
    placeholder: ctx.otherLabel,
    // Typing a radio group's own answer drops the picked option, as in omp.
    onInput: (event: { currentTarget: HTMLInputElement }) => {
      const box = event.currentTarget;
      if (type === "radio" && box.value.trim() !== "" && box.form) for (const radio of namedInputs(box.form, name, type)) radio.checked = false;
      if (box.form) syncOtherValidity(box.form);
    },
    className: "extension-field",
    style: { width: "100%" },
  });
}

function formNode(node: ChildNode, ctx: FormCtx, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  if (ctx.adopted.has(element)) return null;
  let out = formElement(element, ctx, key);
  const label = ctx.rows.get(element);
  if (label) {
    out = createElement("div", { key, className: "extension-choice" }, out, formElement(label, ctx, `${key}.label`));
  }
  const other = ctx.others.get(element);
  return other ? createElement(Fragment, { key }, out, otherBox(other, ctx, `${key}.other`)) : out;
}

function formElement(element: Element, ctx: FormCtx, key: string): ReactNode {
  const tag = element.localName;
  if (DROPPED_TAGS[tag]) return null;
  const children = Array.from(element.childNodes, (child, index) => formNode(child, ctx, `${key}.${index}`));
  if (!FORM_TAGS[tag]) return createElement(Fragment, { key }, ...children);
  const attr = (name: string) => element.getAttribute(name) ?? undefined;
  const length = (name: string) => element.hasAttribute(name) ? Number(element.getAttribute(name)) : undefined;
  const props: Record<string, unknown> = { key };
  const id = attr("id");
  if (id) props.id = `${ctx.prefix}-${id}`;
  if (tag === "label" && attr("for")) props.htmlFor = `${ctx.prefix}-${attr("for")}`;
  // Each radio/checkbox option sits on its own row, its control spaced from its label.
  if (tag === "label" && Array.from(element.querySelectorAll("input")).some(choiceType)) props.className = "extension-choice";
  if (tag === "input" || tag === "select" || tag === "textarea") {
    Object.assign(props, { name: attr("name"), required: element.hasAttribute("required") && !ctx.grouped.has(element), disabled: element.hasAttribute("disabled") });
  }
  if (tag === "input") {
    const rawType = attr("type")?.toLowerCase() ?? "text";
    const type = INPUT_TYPES[rawType] ? rawType : "text";
    Object.assign(props, { type, placeholder: attr("placeholder"), min: attr("min"), max: attr("max"), step: attr("step"), pattern: attr("pattern"), minLength: length("minlength"), maxLength: length("maxlength") });
    if (type === "radio" || type === "checkbox") {
      Object.assign(props, { value: attr("value") ?? "on", defaultChecked: element.hasAttribute("checked") });
    } else {
      Object.assign(props, { defaultValue: attr("value") ?? "", className: "extension-field" });
    }
    return createElement("input", props);
  }
  if (tag === "textarea") {
    Object.assign(props, { placeholder: attr("placeholder"), rows: length("rows"), minLength: length("minlength"), maxLength: length("maxlength"), defaultValue: element.textContent ?? "", className: "extension-field", style: { width: "100%", resize: "vertical" } });
    return createElement("textarea", props);
  }
  if (tag === "select") {
    const multiple = element.hasAttribute("multiple");
    const selected = Array.from(element.querySelectorAll("option"))
      .filter((option) => option.hasAttribute("selected"))
      .map((option) => option.getAttribute("value") ?? option.textContent ?? "");
    Object.assign(props, { multiple, defaultValue: multiple ? selected : selected[0], className: "extension-field" });
  }
  if (tag === "option") Object.assign(props, { value: attr("value") ?? element.textContent ?? "", disabled: element.hasAttribute("disabled") });
  if (tag === "optgroup") props.label = attr("label");
  if (tag === "br" || tag === "hr") return createElement(tag, props);
  return createElement(tag, props, ...children);
}

/** What the form submits, as omp's html-form reports it (see HtmlFormData). */
export function readFormData(form: HTMLFormElement): HtmlFormData {
  const data: HtmlFormData = {};
  const controls = queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form, "input, select, textarea").filter((control) => control.name && !control.disabled);
  for (const control of controls) {
    const { name } = control;
    if (control.tagName === "SELECT") {
      const select = control as HTMLSelectElement;
      const values = Array.from(select.selectedOptions).filter((option) => !option.disabled).map((option) => option.value);
      if (select.multiple) data[name] = values;
      else if (values[0] !== undefined) data[name] = values[0];
      continue;
    }
    const { type, value } = control as HTMLInputElement;
    if (type === "radio" || type === "checkbox") {
      const options = namedInputs(form, name, type);
      const checked = options.filter((input) => input.checked && !input.disabled).map((input) => input.value);
      const other = queryAll<HTMLInputElement>(form, "input[data-other]").find((box) => box.dataset.other === name && box.dataset.otherType === type);
      const typed = other?.value.trim();
      // Other's text joins a checkbox group's array; it stands in for a radio group's value only while no option is picked.
      if (type === "checkbox" && options.length > 1) data[name] = typed ? [...checked, typed] : checked;
      else if (checked[0] !== undefined) data[name] = checked[0];
      else if (typed) data[name] = typed;
    } else if ((type === "number" || type === "range") && value.trim() !== "" && Number.isFinite(Number(value))) {
      data[name] = Number(value);
    } else {
      data[name] = value;
    }
  }
  return data;
}

/**
 * Overlay dialog for omp's `ExtensionUIContext` dialogs as the runner sends them.
 * Polished UX:
 *   - entrance animation (fade backdrop + scale-in panel)
 *   - focus trap: focus moves into the dialog on open and is returned to the
 *     opener on close; Tab/Shift-Tab wrap inside (via useModalDialog)
 *   - Escape closes as "cancelled" (document-level, top-of-stack only)
 *   - backdrop click closes as "cancelled"
 * Logic and i18n keys are unchanged from the in-ChatWindow original.
 */
export function ExtensionDialog({
  request,
  onRespond,
  attached = false,
}: {
  request: UiDialogRequest;
  /** Answers with omp's return value (`undefined` cancels); resolves `false` when it could not be sent. */
  onRespond: (request: UiDialogRequest, value: UiDialogValue | undefined) => void | Promise<boolean>;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.args[1] ?? "" : "");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const requestIdRef = useRef(request.id);
  // `pointerType` of the latest press: the pointer media query only describes
  // the primary pointer, not the one pressing now.
  const pressPointerRef = useRef<string | null>(null);
  // omp takes one answer per request id and the panel stays up until the next request arrives, so the
  // select controls are disabled in that window instead of sending a tap omp would silently drop.
  const [answeredId, setAnsweredId] = useState<UiDialogRequest["id"] | null>(null);
  const awaitingNext = request.method === "select" && answeredId === request.id;
  const [askDrafts, setAskDrafts] = useState(() => initialAskDrafts(request));
  const viewportMaxHeight = useViewportMaxHeight();
  const formRef = useRef<HTMLFormElement>(null);
  // Parsed in an inert document and never attached: only formNode's elements reach the page.
  const otherLabel = t("chatWindow.askOther");
  const formContent = useMemo(() => {
    if (request.method !== "formDialog") return null;
    const doc = new window.DOMParser().parseFromString(request.args[0], "text/html");
    const root = doc.querySelector("form") ?? doc.body;
    const ctx = planForm(root, `form-${request.id}`, otherLabel);
    return Array.from(root.childNodes, (node, index) => formNode(node, ctx, String(index)));
  }, [request, otherLabel]);
  // Required groups with an Other answer are validated through that answer's text box.
  useEffect(() => {
    if (formRef.current) syncOtherValidity(formRef.current);
  }, [formContent]);

  useEffect(() => {
    // SSE reconnects replay the same request as a fresh object, not a new question.
    if (requestIdRef.current === request.id) return;
    requestIdRef.current = request.id;
    setValue(request.method === "editor" ? request.args[1] ?? "" : "");
    setShowPassword(false);
    setSelectedOption(null);
    setAskDrafts(initialAskDrafts(request));
  }, [request]);

  const askDraftAt = (index: number) => askDrafts[index] ?? EMPTY_ASK_DRAFT;
  const updateAskDraft = (index: number, update: (draft: AskDraft) => AskDraft) =>
    setAskDrafts((drafts) => drafts.map((draft, i) => i === index ? update(draft) : draft));
  // A chosen Other counts only with text. Multi-select may stay empty;
  // single-select needs a choice or an answer.
  const canSubmit = request.method === "askDialog"
    ? request.args[0].every((question, index) => {
      const { selected, other, otherChosen } = askDraftAt(index);
      return question.multi || selected.length > 0 || (otherChosen && other.trim() !== "");
    })
    : request.method !== "select" || selectedOption !== null;
  const title = dialogTitle(request, t("chatWindow.askTitle"));

  // Answering removes the panel. Release its text field first, in the same
  // task, so the phone keyboard closes once instead of flashing as the
  // focused field disappears from under it.
  const respond = (response: UiDialogValue | undefined) => {
    if (request.method === "select") {
      if (awaitingNext) return;
      setAnsweredId(request.id);
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    const id = request.id;
    void Promise.resolve(onRespond(request, response)).then((sent) => {
      if (sent === false) setAnsweredId((current) => current === id ? null : current);
    });
  };
  const cancel = () => respond(undefined);

  // useModalDialog gives us: focus-in on open, focus-restore on close,
  // document-level Escape (top-of-stack), and Tab wrapping inside the panel.
  const panelRef = useModalDialog<HTMLDivElement>({
    onClose: cancel,
    // A composer-attached request is a regular in-flow panel, not a modal.
    active: !attached,
  });
  const keyboardOpen = useMobileInputOpen(panelRef, attached);
  // While the keyboard is up the panel fills the visible area instead of the
  // taller layout-viewport cap, so the footer with Cancel / Submit stays in
  // reach (#236).
  const attachedMaxHeight = keyboardOpen && viewportMaxHeight !== undefined
    ? `${viewportMaxHeight}px`
    : DEFAULT_PANEL_MAX_HEIGHT;

  useEffect(() => {
    if (!attached) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      // A tap on the composer, not a programmatic focus, opens the keyboard:
      // the request waits to be read on touch devices (#235).
      if (shouldDeferAttachedFocus()) return;
      // The frame runs after paint, by which time the user may already have
      // focused something inside the panel. Never yank focus back.
      if (panel.contains(document.activeElement)) return;
      // Never land on a radio or checkbox: a stray Space on a focused radio
      // selects that option, which silently overwrites what the user typed in
      // "Other". Prefer the first text entry, then any button.
      const target = panel.querySelector<HTMLElement>(
        `${TEXT_ENTRY}, button:not([disabled])`,
      );
      (target ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  const submitValue = () => {
    if (request.method === "confirm") {
      respond(true);
    } else if (request.method === "select") {
      if (selectedOption !== null) respond(selectedOption);
    } else if (request.method === "askDialog") {
      if (!canSubmit) return;
      respond({
        kind: "submit",
        results: request.args[0].map((question, index) => {
          const draft = askDraftAt(index);
          const customInput = draft.otherChosen ? draft.other.trim() : "";
          const options = question.options.map((option) => option.label);
          return {
            id: question.id,
            question: question.question,
            options,
            multi: question.multi ?? false,
            selectedOptions: options.filter((label) => draft.selected.includes(label)),
            ...(customInput ? { customInput } : {}),
          };
        }),
      });
    } else if (request.method === "formDialog") {
      const form = formRef.current;
      if (form) syncOtherValidity(form);
      if (form && Object.getPrototypeOf(form).reportValidity.call(form)) respond({ data: readFormData(form) });
    } else if (request.method !== "approve") {
      respond(value);
    }
  };

  return (
    <div
      className={attached ? undefined : "animate-fade-in"}
      onMouseDown={attached ? undefined : (event) => {
        // Close when the pointer goes down on the backdrop itself (not when
        // the press starts inside the panel and is dragged out).
        if (event.target === event.currentTarget) cancel();
      }}
      style={attached ? { width: "100%", flexShrink: 0 } : {
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--overlay-backdrop)",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={attached ? undefined : "true"}
        aria-label={title}
        tabIndex={-1}
        // While a text box in the panel has focus, a tap elsewhere in it (an
        // option, Cancel, Submit) must not move focus on press: the phone
        // keyboard would close and the panel resize before the click, so the
        // tap misses its target. A tapped option label still focuses its radio
        // once the click lands, so the keyboard closes after the choice.
        // Touch and pen only, judged per press (a hybrid laptop has both): a
        // mouse keeps text selection and radio arrow keys.
        onPointerDown={(event) => { pressPointerRef.current = event.pointerType; }}
        onMouseDown={(event) => {
          const target = event.target as Element;
          const pointer = pressPointerRef.current;
          if (pointer && pointer !== "mouse" && document.activeElement?.matches(TEXT_ENTRY) && event.currentTarget.contains(document.activeElement) && !target.closest(TEXT_ENTRY)) {
            event.preventDefault();
          }
        }}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(560px, 100%)",
          boxSizing: "border-box",
          // Grid/flex children below must be able to shrink: a min-content
          // question or option is wider than a phone, and without this the
          // panel grows past its composer column and gets clipped (#234).
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? attachedMaxHeight : "100%",
        }}
      >
        <div className="extension-dialog-content" style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere" }}>
        <div className="extension-dialog-header">
          <div style={{ color: "var(--text)", fontSize: 14, lineHeight: "20px", fontWeight: 650, whiteSpace: "pre-wrap" }}>{title}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11, lineHeight: "16px", fontFamily: "var(--font-mono)" }}>{t("chatWindow.extensionRequest")}</div>
        </div>

        <div className="extension-dialog-body">
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.args[1]}</div>
          )}
          {request.method === "approve" && (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ marginBottom: 6, padding: "8px 12px", borderRadius: 8, background: "var(--tool-bg)", color: "var(--text-muted)", fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
                {request.args[0].full.split("\n").slice(1).join("\n")}
              </div>
              {approvalChoices(request, t("settingsConfig.allow"), t("settingsConfig.deny")).map((choice) => (
                <button key={choice.label} className="extension-choice" onClick={() => respond(choice.value)}>
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {request.method === "select" && (() => {
            const [, items, dialogOptions] = request.args;
            return (
            <div style={{ display: "grid", gap: 6 }}>
              {items.map((item, index) => {
                const option = typeof item === "string" ? item : item.label;
                const selected = selectedOption === option;
                const markable = dialogOptions?.selectionMarker === "checkbox";
                const checkbox = markable && index < (dialogOptions.markableCount ?? items.length);
                const checked = checkbox && (dialogOptions.checkedIndices?.includes(index) ?? false);
                // A checkbox toggle goes out at once even when attached: staging it for Next would let the
                // next row (often "Done selecting") silently replace it, and a stray toggle is undone by one tap.
                const stage = attached && !checkbox;
                return (
                  <button
                    key={option}
                    // A row past omp's markable ones ("Done selecting") is an action, not an answer.
                    className={markable && !checkbox ? "extension-choice extension-choice-action" : "extension-choice"}
                    data-checked={selected || checked || undefined}
                    onClick={() => stage ? setSelectedOption(option) : respond(option)}
                    disabled={awaitingNext}
                    aria-pressed={stage ? selected : undefined}
                  >
                    {checkbox && <span aria-hidden="true" className="extension-choice-mark">{checked ? "☑" : "☐"}</span>}
                    <span style={{ minWidth: 0 }}>
                      {option}
                      {typeof item !== "string" && item.description && (
                        <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: "18px" }}>{item.description}</span>
                      )}
                      {checkbox && <span className="sr-only">, {t(checked ? "chatWindow.optionChecked" : "chatWindow.optionUnchecked")}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            );
          })()}
          {request.method === "input" && (() => {
            const [inputTitle, placeholder, dialogOptions] = request.args;
            const isSensitive = Boolean(dialogOptions?.secret) ||
              (dialogOptions?.secret !== false && isSensitivePrompt(inputTitle, placeholder ?? undefined));
            return (
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  autoFocus
                  type={isSensitive && !showPassword ? "password" : "text"}
                  autoComplete={isSensitive ? "off" : undefined}
                  autoCorrect={isSensitive ? "off" : undefined}
                  autoCapitalize={isSensitive ? "off" : undefined}
                  spellCheck={isSensitive ? false : undefined}
                  data-1p-ignore={isSensitive ? "true" : undefined}
                  aria-label={inputTitle || placeholder || "Input value"}
                  value={value}
                  placeholder={placeholder ?? undefined}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitValue();
                  }}
                  className="extension-field"
                  style={{ width: "100%", paddingRight: isSensitive ? 36 : undefined }}
                />
                {isSensitive && (
                  <button
                    type="button"
                    aria-label={showPassword ? t("chatWindow.hidePassword") : t("chatWindow.showPassword")}
                    title={showPassword ? t("chatWindow.hidePassword") : t("chatWindow.showPassword")}
                    onClick={() => setShowPassword((prev) => !prev)}
                    style={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 24,
                      height: 24,
                      padding: 0,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                    }}
                  >
                    {showPassword ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                )}
              </div>
            );
          })()}
          {request.method === "editor" && (
            <textarea
              autoFocus
              aria-label={request.args[0] || "Input value"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              className="extension-field"
              style={{
                width: "100%",
                height: "min(220px, 30dvh)",
                minHeight: 80,
                resize: "vertical",
                fontSize: request.args[3]?.promptStyle ? "var(--chat-font-size)" : 13,
                lineHeight: 1.55,
                fontFamily: request.args[3]?.promptStyle ? "inherit" : "var(--font-mono)",
              }}
            />
          )}
          {request.method === "askDialog" && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
              {request.args[0].map((question, index) => {
                const draft = askDraftAt(index);
                const chooseKeptOther = () => {
                  if (draft.otherChosen || !draft.other.trim()) return;
                  updateAskDraft(index, (current) => ({ ...current, selected: question.multi ? current.selected : [], otherChosen: true }));
                };
                return (
                  <fieldset key={question.id} style={{ margin: 0, padding: 0, border: "none", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
                    <legend style={{ padding: 0, marginBottom: 8, color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: "20px" }}>
                      {question.header && (
                        <span style={{ display: "inline-block", marginRight: 8, padding: "0 6px", borderRadius: 4, background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 11, lineHeight: "18px", fontWeight: 500, verticalAlign: "1px" }}>
                          {question.header}
                        </span>
                      )}
                      <span style={{ whiteSpace: "pre-wrap" }}>{question.question}</span>
                    </legend>
                    {question.options.map((option, optionIndex) => {
                      const checked = draft.selected.includes(option.label);
                      return (
                        <label key={option.label} className="extension-choice">
                          <input
                            type={question.multi ? "checkbox" : "radio"}
                            name={`ask-${request.id}-${index}`}
                            checked={checked}
                            onChange={(event) => {
                              // A tap on the radio itself, unlike one on its label, does
                              // not focus it once the press keeps focus in Other. Focus it
                              // so the keyboard closes and further typing cannot pick Other.
                              event.currentTarget.focus();
                              updateAskDraft(index, (current) => question.multi
                                ? { ...current, selected: current.selected.includes(option.label) ? current.selected.filter((label) => label !== option.label) : [...current.selected, option.label] }
                                : { ...current, selected: [option.label], otherChosen: false });
                            }}
                          />
                          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                            {option.label}
                            {optionIndex === question.recommended && (
                              <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>{t("chatWindow.askRecommended")}</span>
                            )}
                            {option.description && (
                              <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{option.description}</span>
                            )}
                            {option.preview && (
                              <span style={{ display: "block", marginTop: 6, padding: 8, border: "1px solid var(--border)", borderRadius: 6, background: "var(--tool-bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{option.preview}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {/* The Other option: its text box is the option, so what was
                        typed stays in place while another option is chosen. */}
                    <div className="extension-choice" data-checked={draft.otherChosen || undefined}>
                      <input
                        type={question.multi ? "checkbox" : "radio"}
                        name={`ask-${request.id}-${index}`}
                        aria-label={t("chatWindow.askOther")}
                        checked={draft.otherChosen}
                        onChange={(e) => {
                          const chosen = e.target.checked;
                          updateAskDraft(index, (current) => ({ ...current, selected: chosen && !question.multi ? [] : current.selected, otherChosen: chosen }));
                          if (chosen) document.getElementById(`ask-${request.id}-${index}-other`)?.focus();
                        }}
                      />
                      <textarea
                        id={`ask-${request.id}-${index}-other`}
                        aria-label={t("chatWindow.askOther")}
                        placeholder={t("chatWindow.askOther")}
                        value={draft.other}
                        // Going back into kept text means answering with it again.
                        // A tap counts too: unticking Other by touch keeps focus in
                        // this box, so tapping back into it fires no focus event.
                        onFocus={chooseKeptOther}
                        onClick={chooseKeptOther}
                        rows={1}
                        onChange={(e) => {
                          const other = e.target.value;
                          // Typing chooses Other (replacing a single-select choice);
                          // clearing it unchooses, so a blank answer never blocks Submit.
                          updateAskDraft(index, (current) => other.trim()
                            ? { selected: question.multi ? current.selected : [], other, otherChosen: true }
                            : { ...current, other, otherChosen: false });
                        }}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: 0,
                          border: "none",
                          background: "none",
                          color: "var(--text)",
                          outline: "none",
                          resize: "none",
                          fontSize: "var(--chat-font-size)",
                          lineHeight: 1.55,
                          fontFamily: "inherit",
                          fieldSizing: "content",
                          minHeight: "1.55em",
                          maxHeight: 200,
                        }}
                      />
                    </div>
                  </fieldset>
                );
              })}
            </div>
          )}
          {request.method === "formDialog" && (
            <form
              key={request.id}
              ref={formRef}
              onChange={(event) => syncOtherValidity(event.currentTarget)}
              onSubmit={(event) => { event.preventDefault(); submitValue(); }}
              className="extension-dialog-form"
            >
              {formContent}
            </form>
          )}
        </div>
        </div>

        <div className="extension-dialog-footer" style={{ display: "flex", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button className="extension-dialog-button" onClick={cancel}>
            {t("chatWindow.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button className="extension-dialog-button extension-dialog-button-primary" onClick={submitValue}>
              {t("chatWindow.confirm")}
            </button>
          ) : (request.method === "select" && attached) || request.method === "askDialog" ? (
            <button className="extension-dialog-button extension-dialog-button-primary" onClick={submitValue} disabled={!canSubmit || awaitingNext}>
              {request.method === "askDialog" ? t("chatWindow.submit") : t("chatWindow.next")}
            </button>
          ) : request.method !== "select" && request.method !== "approve" ? (
            <button className="extension-dialog-button extension-dialog-button-primary" onClick={submitValue}>
              {t("chatWindow.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
