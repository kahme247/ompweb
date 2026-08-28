export interface SearchRow {
  /** Path relative to the search root, as returned by the index. */
  path: string;
  name: string;
  /** Parent directory, empty for a file sitting at the root. */
  directory: string;
}

/**
 * Turn ranked index matches into rows for the explorer's search panel.
 *
 * Order is the contract here: `/api/file-index` already ranks matches (exact
 * name, then name prefix, then name substring, then path substring, then
 * subsequence), so the panel must render them in exactly that order. Folding
 * results into a directory tree would re-sort them alphabetically and bury the
 * best match under whichever branch happens to sort first.
 */
export function buildSearchRows(paths: string[]): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const cut = path.lastIndexOf("/");
    rows.push({
      path,
      name: cut === -1 ? path : path.slice(cut + 1),
      directory: cut === -1 ? "" : path.slice(0, cut),
    });
  }
  return rows;
}
