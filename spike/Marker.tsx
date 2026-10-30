// HMR probe: a leaf component edited during the dev-server test (React Fast Refresh keeps state if it works).
import { useState } from "react";

export function Marker() {
  const [count] = useState(() => Math.random());
  return <span id="hmr-marker" data-state={count} hidden>v1</span>;
}
