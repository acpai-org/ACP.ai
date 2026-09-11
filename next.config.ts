import type { NextConfig } from "next";

// Every @x402/* specifier that @coinbase/cdp-sdk (transitive dep via
// @wagmi/connectors → @base-org/account) references. These are OPTIONAL
// peers that are deliberately not installed; turbopack hard-fails on
// unresolvable specifiers, so each one is aliased to an empty stub module
// (see stubs/x402-stub.ts). List generated from:
//   grep -rho '"@x402/[^"]*"' node_modules/@coinbase/cdp-sdk/_esm/ \
//     node_modules/@base-org/account/dist/ | sort -u
const X402_SPECIFIERS = [
  "@x402/core/client",
  "@x402/core/server",
  "@x402/evm",
  "@x402/evm/batch-settlement/client",
  "@x402/evm/exact/client",
  "@x402/evm/exact/server",
  "@x402/evm/exact/v1/client",
  "@x402/evm/upto/client",
  "@x402/evm/upto/server",
  "@x402/express",
  "@x402/extensions/bazaar",
  "@x402/extensions/builder-code",
  "@x402/fetch",
  "@x402/svm/exact/client",
  "@x402/svm/exact/server",
  "@x402/svm/exact/v1/client",
] as const;

const X402_TURBOPACK_ALIASES: Record<string, string> = Object.fromEntries(
  X402_SPECIFIERS.map((spec) => [spec, "./stubs/x402-stub.ts"]),
);

const nextConfig: NextConfig = {
  // Cache Components disabled ON PURPOSE: the entire app frame renders
  // client-side (Web3Provider is browser-only — see app-shell.tsx), so no
  // route can be prerendered. Keeping cacheComponents on made the dev
  // prerender-validation probe log "Could not validate instant … Bail out
  // to client-side rendering: next/dynamic" on every navigation (51 console
  // errors across one route sweep) with zero caching benefit. The required
  // `export const instant` opt-outs were removed from pages/layout.
  cacheComponents: false,
  reactCompiler: true,
  // node:sqlite is a Node builtin (automatically external); drizzle-orm stays
  // external so the server bundle imports it from node_modules at runtime.
  serverExternalPackages: ["drizzle-orm"],
  productionBrowserSourceMaps: false,
  compress: true,
  generateEtags: false,
  poweredByHeader: false,
  httpAgentOptions: {
    keepAlive: true,
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
  },
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 3600,
  },
  experimental: {},
  turbopack: {
    // Alias the optional (not installed) @x402/* packages to an empty stub
    // module. Without this, turbopack fails with "Module not found: Can't
    // resolve '@x402/core/client'" on the cdp-sdk dynamic imports.
    resolveAlias: {
      ...X402_TURBOPACK_ALIASES,
      // Stub out @wagmi/connectors — the appkit adapter's lazy
      // Coinbase/Base/Safe connector import is the only entry into that
      // barrel (and the @base-org/account → cdp-sdk subtree behind it).
      // Cutting it saves ~1GB of dev compile memory and a large slice of
      // the browser payload. See stubs/wagmi-connectors-stub.ts.
      "@wagmi/connectors": "./stubs/wagmi-connectors-stub.ts",
    },
  },
};

export default nextConfig;
