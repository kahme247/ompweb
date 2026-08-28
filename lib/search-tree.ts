export interface SearchTreeNode {
  name: string;
  /** Full relative path of this node, e.g. "components/App.tsx" or "components". */
  path: string;
  isDir: boolean;
  children: SearchTreeNode[];
}

/**
 * Fold flat search-result paths into a directory tree. Directories come
 * before files and siblings are sorted alphabetically at every level, so the
 * results read like the real file tree. Duplicate paths collapse into a
 * single node.
 */
export function buildSearchTree(paths: string[]): SearchTreeNode[] {
  const roots: SearchTreeNode[] = [];
  const byPath = new Map<string, SearchTreeNode>();
  for (const relative of paths) {
    // Index results are clean relative paths, but a stray leading, trailing or
    // doubled slash would otherwise produce nameless nodes.
    const segments = relative.split("/").filter((segment) => segment.length > 0);
    let current = roots;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i];
      const isDir = i < segments.length - 1;
      let node = byPath.get(currentPath);
      if (!node) {
        node = { name: segments[i], path: currentPath, isDir, children: [] };
        byPath.set(currentPath, node);
        current.push(node);
      } else if (isDir && !node.isDir) {
        // The same name already arrived as a leaf ("a" before "a/b"). Keeping it
        // a file would render it without its children, which are matches too.
        node.isDir = true;
      }
      current = node.children;
    }
  }
  const sort = (nodes: SearchTreeNode[]) => {
    nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
