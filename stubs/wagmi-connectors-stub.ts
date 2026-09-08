// Empty-module stub for @wagmi/connectors (safe / baseAccount / coinbaseWallet).
//
// WHY: @reown/appkit-adapter-wagmi lazily calls
//   `await import('@wagmi/connectors')`
// in three places (getSafeConnector / getBaseAccountConnector /
// getCoinbaseConnector in utils/helpers.js) and destructures exactly three
// names, each guarded by `if (name && …)` so `undefined` degrades to "this
// connector is not available" and is skipped gracefully.
//
// That dynamic import is the ONLY entry into the @wagmi/connectors barrel in
// this app's graph (verified: `wagmi` re-exports it at `wagmi/connectors`,
// but nothing imports that path; our src only uses `wagmi` hooks). The
// barrel pulls @base-org/account → @coinbase/cdp-sdk → the x402/* optional
// peers — by far the biggest subtree in the client bundle. Turbopack
// compiles dynamic imports eagerly, so merely having the specifier in the
// adapter costs ~1GB of dev-server compile memory even though the Coinbase
// smart-wallet path is never used.
//
// Effect: the Coinbase SDK connector is not offered (users with Coinbase
// Wallet can still connect through the WalletConnect protocol — the modal
// list comes from the Reown registry, not from this package). This mirrors
// the x402 stub approach; names stay `undefined` so any accidental real use
// fails loudly instead of silently pretending to work.
export const safe = undefined;
export const baseAccount = undefined;
export const coinbaseWallet = undefined;
export {};

const stubDefault = {};
export default stubDefault;
