import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import { ThemeColor } from "@/hooks/useTheme";
import { IosFocusZoomGuard } from "@/components/IosFocusZoomGuard";
import { SIDEBAR_HISTORY_BRIDGE_SCRIPT } from "@/lib/sidebar-history-bridge";
import { getInstallName } from "@/lib/install-name";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const title = getInstallName(await headers());
  return {
    title,
    description: "Web UI for the oh-my-pi (omp) coding agent",
    // PWA-like behavior on iOS: standalone chrome, no telephone autodetect.
    appleWebApp: {
      capable: true,
      title,
      statusBarStyle: "default",
    },
    formatDetection: {
      telephone: false,
    },
  };
}

// `viewportFit: cover` honors safe-area-inset on notched devices.
// `interactiveWidget: resizes-content` makes the soft keyboard shrink the
// layout viewport, keeping the composer above the keyboard.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/api/manifest" crossOrigin="use-credentials" />
        <ThemeColor />
        <meta name="google" content="notranslate" />
        {/* Register before Next's router. Owned sidebar traversals must be handled
            before the router can synchronously restore an older session URL. */}
        <Script id="sidebar-history" strategy="beforeInteractive">
          {SIDEBAR_HISTORY_BRIDGE_SCRIPT}
        </Script>
        {/* Apply the stored theme and its CSS background to browser chrome before
            first paint. The hydrated hook keeps both in sync afterward. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t;try{t=localStorage.getItem("omp-theme")}catch(e){}var d=matchMedia("(prefers-color-scheme: dark)").matches;var dt={"dark":1,"omp":1,"dracula":1,"harbor":1,"one-dark-pro":1,"rose-pine":1,"catppuccin-mocha":1,"gruvbox-dark":1,"nord":1,"tokyo-night":1};var lt={"light":1,"one-light":1,"catppuccin-latte":1,"rose-pine-dawn":1};var res=t==="system"?(d?"dark":"light"):(!t?"omp":t);if(!dt[res]&&!lt[res]&&res!=="omp")res="omp";var dark=!!dt[res]&&res!=="omp";if(dark)document.documentElement.classList.add("dark");if(res==="omp"){document.documentElement.classList.add("omp")}else{document.documentElement.classList.add("theme-"+res)}document.documentElement.setAttribute("data-theme",res);var m=document.querySelector('meta[name="theme-color"]'),c=getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();if(m&&c)m.setAttribute("content",c);}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var l=localStorage.getItem("omp-lang");if(l!=="en"&&l!=="zh-CN"&&l!=="ja"){var n=(navigator.language||"").toLowerCase();l=n.indexOf("zh")===0?"zh-CN":n.indexOf("ja")===0?"ja":"en"}document.documentElement.lang=l}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var f=localStorage.getItem("omp-font-size");if(f==="sm"||f==="md"||f==="lg"||f==="xl")document.documentElement.setAttribute("data-font-size",f)}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("omp-ui-scale");if(s==="compact"||s==="standard"||s==="comfortable"||s==="large")document.documentElement.setAttribute("data-ui-scale",s)}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("omp-touch-targets");if(t==="auto"||t==="compact"||t==="accessible")document.documentElement.setAttribute("data-touch-targets",t)}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100%", maxHeight: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <IosFocusZoomGuard />
        {children}
      </body>
    </html>
  );
}
