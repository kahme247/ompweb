// The installed app's Android system bars take their color from the manifest,
// but Chrome refreshes an installed app's manifest without cookies. The color
// therefore travels in the manifest URL: the browser remembers the theme in a
// cookie, the server renders it into the link, and the hook updates the link.
export const THEME_COLOR_COOKIE = "omp-theme-color";

const HEX = /^[0-9a-f]{6}$/i;

/** `/api/manifest` for a `RRGGBB` color; the plain URL for anything else. */
export function manifestHref(hex: string | null | undefined): string {
  return hex && HEX.test(hex) ? `/api/manifest?theme=${hex}` : "/api/manifest";
}

/** `#RRGGBB` for a valid `RRGGBB` value, else undefined. */
export function parseThemeColor(hex: string | null | undefined): string | undefined {
  return hex && HEX.test(hex) ? `#${hex}` : undefined;
}
