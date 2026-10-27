"use client";

import { Children, cloneElement, isValidElement, useContext, useMemo, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { remarkInlineCodeFileLinks, resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { AgentLinkContext, agentAwareUrlTransform, agentLinkIds, remarkAgentLinks } from "../lib/agent-links";
import { GithubRepoContext, remarkGithubRefs } from "../lib/github-refs";
import { normalizeDisplayMath, useMarkdownPlugins, type MarkdownPlugins } from "../lib/markdown";
import { markdownCodeRenderer } from "./MarkdownCode";
import { ClickableImage } from "./ImageLightbox";
import { TableChart } from "./TableChart";

/** Props accepted by `MarkdownBody`. */
export interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  suppressImages?: boolean;
  autoCharts?: boolean;
}

/** Everything `MarkdownBody` hands to `ReactMarkdown`: source text, plugins, element renderers and URL transform. */
export interface MarkdownBodyRendering {
  markdown: string;
  remarkPlugins: MarkdownPlugins["remarkPlugins"];
  rehypePlugins: MarkdownPlugins["rehypePlugins"];
  components: Components;
  urlTransform: typeof agentAwareUrlTransform;
}

/** Builds omp-web's markdown rendering setup (links, images, tables, code) so any renderer can reuse it. */
export function useMarkdownBodyRendering({ children, isStreaming, cwd, onOpenFile, suppressImages = false, autoCharts = false }: Omit<MarkdownBodyProps, "className">): MarkdownBodyRendering {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const { remarkPlugins: baseRemarkPlugins, rehypePlugins } = useMarkdownPlugins(normalizedMarkdown);
  const githubRepo = useContext(GithubRepoContext);
  // GitHub refs run first: `agent://Foo#12` must not become an issue link.
  // Inline-code paths link only where a click can open them.
  const remarkPlugins = useMemo<MarkdownPlugins["remarkPlugins"]>(
    () => {
      const plugins: MarkdownPlugins["remarkPlugins"] = [...baseRemarkPlugins, [remarkGithubRefs, { repo: githubRepo }], remarkAgentLinks];
      return onOpenFile ? [...plugins, [remarkInlineCodeFileLinks, { cwd }]] : plugins;
    },
    [baseRemarkPlugins, githubRepo, onOpenFile, cwd],
  );
  const openAgentLink = useContext(AgentLinkContext);

  // Rebuilt only when its captured props change, not on every render.
  const components = useMemo<Components>(() => {
    const imgComponent = ({ src, alt, ...imgProps }: ComponentProps<"img"> & { node?: unknown }) => {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete (imgProps as { node?: unknown }).node;
      if (suppressImages) return alt ?? null;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      // Dynamic local paths are served directly by the file API.
      return <ClickableImage src={imageSrc} alt={alt ?? ""} loading="lazy" {...imgProps} />;
    };

    /**
     * Split link children into linked text and previewable images. Images may
     * sit directly or wrapped in formatting (`[**![img](x)**](url)`); a
     * <button> can never nest inside an <a>, so image content is extracted
     * while text (with its formatting) stays linked.
     */
    const isElementWithChildren = (value: unknown): value is ReactElement<{ children?: ReactNode }> => isValidElement(value);
    const partitionLinkContent = (node: ReactNode): { textParts: ReactNode[]; imageParts: ReactNode[] } => {
      const textParts: ReactNode[] = [];
      const imageParts: ReactNode[] = [];
      for (const child of Children.toArray(node)) {
        if (!isElementWithChildren(child)) {
          textParts.push(child);
          continue;
        }
        if (child.type === imgComponent) {
          imageParts.push(child);
          continue;
        }
        const sub = partitionLinkContent(child.props.children);
        if (sub.imageParts.length === 0) {
          textParts.push(child);
        } else if (sub.textParts.length === 0) {
          // Formatting wrapper containing only images moves to the previews.
          imageParts.push(child);
        } else {
          // Mixed wrapper: keep the wrapper with its text, extract the images.
          textParts.push(cloneElement(child, undefined, sub.textParts));
          imageParts.push(...sub.imageParts);
        }
      }
      return { textParts, imageParts };
    };
    /** True when any text part carries non-whitespace content. */
    const hasMeaningfulText = (parts: ReactNode[]): boolean =>
      parts.some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        if (typeof part === "number") return true;
        if (isElementWithChildren(part)) return hasMeaningfulText(Children.toArray(part.props.children));
        return false;
      });

    return {
    code: markdownCodeRenderer({ isStreaming, inlineClassName: "markdown-inline-code" }),
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const { textParts, imageParts } = partitionLinkContent(children);
      // A <button> cannot nest inside an <a>. Pure image links (direct or
      // wrapped in formatting, possibly with surrounding whitespace) render
      // only the previews — the lightbox supersedes the link. Mixed links
      // keep their text linked and render image previews beside the anchor.
      if (imageParts.length > 0 && !hasMeaningfulText(textParts)) {
        return <>{children}</>;
      }
      const agentIds = agentLinkIds(href);
      if (agentIds.length > 0) {
        // Outside a chat view there is nothing to open: render the handle as text.
        if (!openAgentLink) return <>{textParts}{imageParts}</>;
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.defaultPrevented || event.button !== 0) return;
          event.preventDefault();
          openAgentLink(agentIds);
        };
        // Middle-click never fires `click`; stop it opening the unnavigable href.
        const anchor = <a href={href} {...props} onClick={handleClick} onAuxClick={(event) => event.preventDefault()}>{textParts}</a>;
        return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
      }
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (filePath && openFile) {
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const target = event.currentTarget.getAttribute("target");
          if (target && target !== "_self") return;
          event.preventDefault();
          openFile(filePath);
        };
        const anchor = <a href={href} {...props} onClick={handleClick}>{textParts}</a>;
        return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
      }

      const anchor = (
        <a href={href} {...props} target="_blank" rel="noopener noreferrer">
          {textParts}
        </a>
      );
      return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
    },
    img: imgComponent,
    table({ children, node }) {
      return (
        <TableChart node={node} enabled={autoCharts && !isStreaming}>
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
        </TableChart>
      );
    },
    };
  }, [isStreaming, cwd, onOpenFile, suppressImages, openAgentLink, autoCharts]);

  return { markdown: normalizedMarkdown, remarkPlugins, rehypePlugins, components, urlTransform: agentAwareUrlTransform };
}

/** Render agent markdown with `useMarkdownBodyRendering`'s setup. */
export function MarkdownBody({ className, ...props }: MarkdownBodyProps) {
  const { markdown, remarkPlugins, rehypePlugins, components, urlTransform } = useMarkdownBodyRendering(props);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
