import { useId } from "react";

// omp-web brand mark: the omp π glyph on its midnight tile.
// Artwork matches the omp.sh favicon (https://omp.sh/favicon.svg).
export default function OmpWebLogo({
  size = 20,
  label = "omp logo",
}: {
  size?: number;
  label?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const g = `owl-g-${uid}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={label}
      style={{ display: "block", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ed4abf" />
          <stop offset="0.5" stopColor="#9b4dff" />
          <stop offset="1" stopColor="#5ad8e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="#0f0a14" />
      <path fill={`url(#${g})`} d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" />
    </svg>
  );
}
