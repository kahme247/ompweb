"use client";

import { createElement, useEffect, useMemo, useRef, type FormEvent, type ReactNode } from "react";
import { raw } from "hast-util-raw";
import { sanitize, type Schema } from "hast-util-sanitize";
import type { Element, Root, RootContent } from "hast";
import { useI18n } from "@/lib/i18n";

const schema: Schema = {
  tagNames: [
    "p", "div", "span", "br", "hr", "strong", "b", "em", "i", "u", "s", "small", "sub", "sup",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "ul", "ol", "li", "dl", "dt", "dd",
    "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "img", "a",
    "fieldset", "legend", "label", "input", "select", "optgroup", "option", "textarea",
  ],
  attributes: {
    "*": ["id", "title", "lang", "dir", "ariaLabel"],
    label: ["htmlFor"],
    input: ["name", "value", "checked", "disabled", "readOnly", "required", "min", "max", "step",
      "minLength", "maxLength", "pattern", "placeholder", "size",
      ["type", "text", "password", "email", "url", "tel", "search", "number", "range", "date",
        "datetime-local", "month", "week", "time", "color", "hidden", "radio", "checkbox"]],
    select: ["name", "disabled", "required", "multiple", "size"],
    option: ["value", "selected", "disabled", "label"],
    optgroup: ["disabled", "label"],
    textarea: ["name", "disabled", "readOnly", "required", "minLength", "maxLength", "placeholder", "rows", "cols"],
    fieldset: ["disabled"],
    img: ["src", "alt", "width", "height"],
    th: ["colSpan", "rowSpan", "scope"],
    td: ["colSpan", "rowSpan"],
    ol: ["start", "reversed"],
    li: ["value"],
  },
  protocols: { src: ["http", "https", "blob", "data"] },
  // Override the sanitizer's markdown defaults, which disable every input.
  required: {},
  // Names are data keys, never property access; IDs are scoped when rendered.
  clobber: [],
  strip: ["script", "style", "iframe", "object", "embed", "template", "svg", "math"],
};

type Group = { name: string; type: "radio" | "checkbox"; options: Element[]; required: boolean; otherValue: string };
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function elements(node: Root | Element): Element[] {
  return node.children.flatMap((child) => child.type === "element" ? [child, ...elements(child)] : []);
}

function safeImage(src: string): boolean {
  if (/^data:/i.test(src)) return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(src);
  try {
    return ["http:", "https:", "blob:"].includes(new URL(src, "https://omp.invalid/").protocol);
  } catch {
    return false;
  }
}

export function FormDialog({ html, onSubmit, formId }: {
  html: string;
  onSubmit: (data: Record<string, string | number | string[]>) => void;
  formId: string;
}) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const { tree, groups } = useMemo(() => {
    // Parse inertly, sanitize the tree, then render only sanitized nodes through React.
    const source = { type: "root", children: [{ type: "raw", value: html }] } as Parameters<typeof raw>[0];
    const tree = sanitize(raw(source), schema) as Root;
    const byName = new Map<string, Group>();
    for (const node of elements(tree)) {
      const { name, type } = node.properties;
      if (node.tagName !== "input" || !name || (type !== "radio" && type !== "checkbox")) continue;
      const key = `${type}:${name}`;
      let group = byName.get(key);
      if (!group) {
        group = { name: String(name), type, options: [], required: false, otherValue: "__omp_other__" };
        byName.set(key, group);
      }
      group.options.push(node);
      group.required ||= !!node.properties.required;
    }
    for (const group of byName.values()) {
      while (group.options.some((option) => String(option.properties.value ?? "on") === group.otherValue)) group.otherValue += "_";
    }
    return { tree, groups: [...byName.values()].filter((group) => group.options.length >= 2) };
  }, [html]);

  function controls(): Control[] {
    return Array.from(content.current?.querySelectorAll<Control>("input,select,textarea") ?? []);
  }

  function updateConstraints() {
    const all = controls();
    groups.forEach((group, index) => {
      const choices = all.filter((control): control is HTMLInputElement => control.tagName === "INPUT"
        && control.name === group.name && control.type === group.type && !control.matches(":disabled"));
      const other = content.current?.querySelector<HTMLInputElement>(`[data-other-choice="${index}"]`);
      const text = content.current?.querySelector<HTMLInputElement>(`[data-other-text="${index}"]`);
      if (!other || !text) return;
      const originals = all.filter((control) => control.tagName === "INPUT" && control.name === group.name
        && control.type === group.type && control !== other);
      other.disabled = !originals.some((control) => !control.matches(":disabled"));
      text.disabled = other.disabled || !other.checked;
      text.required = !text.disabled;
      const value = text.value.trim();
      text.setCustomValidity(!text.disabled && !value ? t("chatWindow.otherPlaceholder")
        : !text.disabled && group.options.some((option) => String(option.properties.value ?? "on") === value)
          ? t("chatWindow.formOtherUnlisted") : "");
      if (group.type === "checkbox") {
        choices.forEach((choice) => { choice.required = false; });
        // Native checkbox validation, but any selected member satisfies the group.
        const required = group.required && group.options.some((option, optionIndex) =>
          option.properties.required && !originals[optionIndex]?.matches(":disabled"));
        if (required && choices.length && !choices.some((choice) => choice.checked)) choices[0].required = true;
      }
    });
  }

  useEffect(() => {
    updateConstraints();
  });

  function renderNode(node: RootContent, key: number): ReactNode {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const props: Record<string, unknown> = { ...node.properties, key };
    if (props.id) props.id = `${formId}-${props.id}`;
    if (props.htmlFor) props.htmlFor = `${formId}-${props.htmlFor}`;
    if (props.ariaLabel) {
      props["aria-label"] = props.ariaLabel;
      delete props.ariaLabel;
    }
    if (node.tagName === "img" && (!props.src || !safeImage(String(props.src)))) return null;
    if (node.tagName === "input") {
      // An unsupported input type must not become a submit/image/file control.
      props.type ??= "text";
      if ("value" in props) {
        props.defaultValue = props.value;
        delete props.value;
      }
      if ("checked" in props) {
        props.defaultChecked = props.checked;
        delete props.checked;
      }
      return createElement("input", props);
    }
    if (node.tagName === "select") {
      const selected = elements(node).filter((option) => option.tagName === "option" && option.properties.selected);
      if (selected.length) {
        const values = selected.map((option) => String(option.properties.value ?? option.children.map((child) => child.type === "text" ? child.value : "").join("")));
        props.defaultValue = props.multiple ? values : values[values.length - 1];
      }
    }
    if (node.tagName === "option") delete props.selected;
    if (node.tagName === "textarea") {
      props.defaultValue = node.children.map((child) => child.type === "text" ? child.value : "").join("");
      return createElement("textarea", props);
    }
    if (["img", "br", "hr"].includes(node.tagName)) return createElement(node.tagName, props);
    return createElement(node.tagName, props, node.children.map(renderNode));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    updateConstraints();
    // Named controls can shadow form methods (e.g. name="reportValidity").
    const form = event.currentTarget;
    if (!form.ownerDocument.defaultView!.HTMLFormElement.prototype.reportValidity.call(form)) return;
    const data: Record<string, string | number | string[]> = Object.create(null);
    const nativeData = new form.ownerDocument.defaultView!.FormData(form);
    const all = controls().filter((control) => control.name);
    const byName = new Map<string, Control[]>();
    for (const control of all) {
      if (control.hasAttribute("data-other-choice") || control.hasAttribute("data-other-text")) continue;
      const fields = byName.get(control.name) ?? [];
      fields.push(control);
      byName.set(control.name, fields);
    }
    for (const [name, fields] of byName) {
      const field = fields.find((control) => !control.matches(":disabled"));
      if (!field) continue;
      const values = [...new Set(nativeData.getAll(name).filter((value): value is string => typeof value === "string"))];
      if (field.tagName === "SELECT") {
        const select = field as HTMLSelectElement;
        const enabledValues = new Set(Array.from(select.options)
          .filter((option) => option.selected && !option.disabled && !option.parentElement?.matches("optgroup:disabled"))
          .map((option) => option.value));
        const selected = values.filter((value) => enabledValues.has(value));
        if (select.multiple && select.options.length >= 2) data[name] = selected;
        else if (selected.length) data[name] = selected[0];
      } else if (field.type === "radio" || field.type === "checkbox") {
        const groupIndex = groups.findIndex((group) => group.name === name && group.type === field.type);
        if (groupIndex >= 0) {
          const markerIndex = values.indexOf(groups[groupIndex].otherValue);
          if (markerIndex >= 0) values.splice(markerIndex, 1);
          const other = content.current?.querySelector<HTMLInputElement>(`[data-other-choice="${groupIndex}"]`);
          const text = content.current?.querySelector<HTMLInputElement>(`[data-other-text="${groupIndex}"]`);
          if (other?.checked && !other.disabled && text?.value.trim()) values.push(text.value.trim());
        }
        const isMulti = field.type === "checkbox" && groups.some((group) => group.name === name && group.type === "checkbox");
        if (isMulti) data[name] = [...new Set(values)];
        else if (values.length) data[name] = values[0];
      } else if (field.type === "number" || field.type === "range") {
        if (values[0] !== undefined && values[0] !== "") data[name] = Number(values[0]);
      } else {
        data[name] = values[0] ?? "";
      }
    }
    onSubmit(data);
  }

  return (
    <form id={formId} onSubmit={submit} onInput={updateConstraints} onChange={updateConstraints}
      className="min-w-0 text-[color:var(--text)] [&_fieldset]:min-w-0 [&_fieldset]:space-y-2 [&_legend]:mb-2 [&_legend]:font-medium [&_label]:leading-relaxed [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:w-full [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:rounded-md [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:border [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:border-[var(--border)] [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:bg-[var(--bg)] [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:px-3 [&_input:not([type=radio]):not([type=checkbox]):not([type=hidden])]:py-2 [&_input]:accent-[var(--accent-strong)] [&_input:disabled]:opacity-50 [&_textarea]:w-full [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-[var(--border)] [&_textarea]:bg-[var(--bg)] [&_textarea]:px-3 [&_textarea]:py-2 [&_select]:max-w-full [&_select]:rounded-md [&_select]:border [&_select]:border-[var(--border)] [&_select]:bg-[var(--bg)] [&_select]:px-3 [&_select]:py-2 [&_img]:max-w-full [&_table]:w-full [&_th]:text-left [&_td]:p-2 [&_th]:p-2">
      <div ref={content} key={html} className="flex flex-col gap-3">
        {tree.children.map(renderNode)}
        {groups.map((group, index) => (
          <fieldset key={`${group.type}:${group.name}`} className="flex flex-col gap-2">
            <legend>{group.name}</legend>
            <label className="flex items-center gap-2">
              <input type={group.type} name={group.name} value={group.otherValue} data-other-choice={index} />
              {t("chatWindow.other")}
            </label>
            <input type="text" data-other-text={index} aria-label={`${group.name}: ${t("chatWindow.other")}`}
              placeholder={t("chatWindow.otherPlaceholder")} disabled />
          </fieldset>
        ))}
      </div>
    </form>
  );
}
