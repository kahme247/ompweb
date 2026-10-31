// Imported first by client.tsx so it runs before AppShell's module evaluates and registers its own popstate listeners.
import { SIDEBAR_HISTORY_BRIDGE_SCRIPT } from "@/lib/sidebar-history-bridge";

const script = document.createElement("script");
script.textContent = SIDEBAR_HISTORY_BRIDGE_SCRIPT;
document.head.append(script);
