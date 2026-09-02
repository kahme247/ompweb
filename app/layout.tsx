import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono, Noto_Serif_SC, Source_Serif_4 } from "next/font/google";
import "./globals.css";

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

// theme-color adapts to light/dark so the browser chrome / iOS status bar
// matches the active theme. `viewportFit: cover` lets us honor safe-area-inset
// (used by DirectoryPicker footer) on notched devices.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF9F6" },
    { media: "(prefers-color-scheme: dark)", color: "#1B1916" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} ${sourceSerif.variable} ${notoSerifSC.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        {/* Pre-hydration: apply stored theme before first paint to avoid a flash
            of the wrong theme. Matches html.dark selector in globals.css. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("omp-theme"),d=matchMedia("(prefers-color-scheme: dark)").matches;if(t==="dark"||(t!=="light"&&t!=="dark"&&d))document.documentElement.classList.add("dark")}catch(e){}})();`,
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
