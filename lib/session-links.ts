export function sessionHref(id: string): string {
  return `/?session=${encodeURIComponent(id)}`;
}

export function sessionLinkHref(
  href: string | undefined,
  origin = typeof window === "undefined" ? undefined : window.location.origin,
): string | null {
  if (!href) return null;
  const relative = href.startsWith("/?") || href.startsWith("?");
  try {
    const url = relative ? new URL(href, "https://session.invalid/") : new URL(href);
    if ((!relative && (!origin || url.origin !== origin)) || url.pathname !== "/" || !url.searchParams.get("session")) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
