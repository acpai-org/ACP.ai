import type { MetadataRoute } from "next";

/**
 * PWA web app manifest — makes ACP.ai installable (Android/desktop Chrome,
 * Edge; iOS uses apple-web-app meta in layout.tsx and these icons for the
 * home screen).
 *
 * theme_color matches the dark chrome (`--bg` brand default in
 * lib/use-theme.ts) because the app boots dark-first; background_color
 * matches the boot overlay so the standalone splash never flashes white.
 * Maskable icons carry the logo at 78% inside a safe zone that survives
 * Android's circular/rounded launch masks.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ACP.ai — Intent-to-Pay Assistant",
    short_name: "ACP.ai",
    description:
      "Send payments in plain language. An AI assistant that turns your intent into verifiable on-chain settlements — powered by the Attestcoin Protocol.",
    start_url: "/",
    display: "standalone",
    background_color: "#121314",
    theme_color: "#121314",
    orientation: "portrait-primary",
    categories: ["finance", "productivity"],
    icons: [
      {
        src: "/brand/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
