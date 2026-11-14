import { useId } from "react";

// ompweb brand mark: a rounded π inside an open orbit on its midnight tile.
export default function OmpWebLogo({
  size = 20,
  label = "ompweb logo",
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
      <rect width="64" height="64" rx="15" fill="#0f0a14" />
      <g fill="none" stroke={`url(#${g})`} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M49 17A23 23 0 1 0 55 34" />
        <path d="M21 24H43M26 24V39M37 24V44" />
      </g>
    </svg>
  );
}
