import localFont from "next/font/local";
import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const geistSans = localFont({
  src: "../fonts/Geist[wght].woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
  preload: true,
  fallback: ["system-ui", "sans-serif"],
});

const geistMono = localFont({
  src: "../fonts/GeistMono[wght].woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
});

const spaceMono = localFont({
  src: [
    {
      path: "../fonts/SpaceMono-Regular.ttf",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/SpaceMono-Bold.ttf",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-space-mono",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "ACP.ai — Intent-to-Pay Assistant",
  description:
    "Send payments in plain language. An AI assistant that turns your intent into verifiable on-chain settlements — powered by the Attestcoin Protocol.",
  applicationName: "ACP.ai",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "ACP.ai",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/brand/favicon.ico", type: "image/x-icon", sizes: "any" }],
    apple: [{ url: "/brand/apple-icon.png", sizes: "512x512" }],
  },
};

// The app frame is client-rendered (web3 provider is browser-only — see
// app-shell.tsx), so route-level caching/prerendering never applies.

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // cover → env(safe-area-inset-*) resolves on iOS notches/home indicator
  viewportFit: "cover",
  themeColor: [
    // Light: matches the N18 light page bg (cool grey, zero violet tint —
    // was #f6f4f9, a purple-tinted off-white).
    { media: "(prefers-color-scheme: light)", color: "#e6eaee" },
    { media: "(prefers-color-scheme: dark)", color: "#121314" },
  ],
};

// No-FOUC theme bootstrap: mirrors src/lib/use-theme.ts exactly (dark is the
// brand default; "system" follows the OS). Runs before first paint so a
// light-theme user never sees a dark flash.
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("acp-ai:theme");var c=p==="light"||p==="dark"?p:(p==="system"?(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):"dark");var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(c);}catch(e){}try{var f=JSON.parse(localStorage.getItem("acp-ai:font")||"null");if(f){var s=Number(f.scale);if(s===0.9||s===1||s===1.1){r.style.fontSize=Math.round(16*s)+"px";}if(f.family==="system"){r.dataset.font="system";}}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${spaceMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full text-foreground">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}