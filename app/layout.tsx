import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist, JetBrains_Mono, Noto_Sans_Mono, Noto_Serif_SC, Source_Serif_4 } from "next/font/google";
import { ThemeColor } from "@/hooks/useTheme";
import { SIDEBAR_HISTORY_BRIDGE_SCRIPT } from "@/lib/sidebar-history-bridge";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jb-mono",
  display: "swap",
});

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

// Display serif pair for the warm-humanistic heading voice: Source Serif 4
// covers latin, Noto Serif SC covers CJK. Both expose CSS variables consumed
// by --font-serif in globals.css.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

const notoSerifSC = Noto_Serif_SC({
  // CJK glyphs are served via unicode-range slices regardless of subset;
  // "latin" satisfies next/font's preloading requirement.
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-noto-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "omp web",
  description: "Web UI for the oh-my-pi (omp) coding agent",
  // PWA-like behavior on iOS: standalone chrome, no telephone autodetect.
  appleWebApp: {
    capable: true,
    title: "omp web",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

// `viewportFit: cover` honors safe-area-inset on notched devices.
// `interactiveWidget: resizes-content` makes the soft keyboard shrink the
// layout viewport, keeping the composer above the keyboard.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${geist.variable} ${jetbrainsMono.variable} ${notoSansMono.variable} ${sourceSerif.variable} ${notoSerifSC.variable} notranslate`} suppressHydrationWarning>
      <head>
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
      </head>
      <body translate="no" className="notranslate" style={{ height: "100%", maxHeight: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
