// Ambient declarations for the untyped react-syntax-highlighter ESM subpath
// imports used by lib/syntax-highlight.ts (the root tsconfig instead relies on
// allowJs inference, which this app's tsconfig does not enable).
declare module "react-syntax-highlighter/dist/esm/create-element" {
  const fn: (...args: unknown[]) => React.ReactNode;
  export default fn;
}

declare module "react-syntax-highlighter/dist/esm/prism-light" {
  import type { ComponentType } from "react";
  const PrismLight: ComponentType<Record<string, unknown>> & {
    registerLanguage: (name: string, fn: unknown) => void;
  };
  export default PrismLight;
}

declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  const language: unknown;
  export default language;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/*" {
  const style: Record<string, Record<string, string>>;
  export default style;
}
