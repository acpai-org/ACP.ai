// Empty-module stub for the optional @x402/* payment packages.
//
// @coinbase/cdp-sdk (a transitive dep of @wagmi/connectors → @base-org/account)
// statically imports a set of "@x402/*" packages that are OPTIONAL peers and
// are intentionally NOT installed in this project. Turbopack hard-fails on
// unresolvable specifiers AND on named imports that don't statically exist in
// the target module — so next.config.ts aliases every known @x402 specifier
// to this file, and this file re-exports every name cdp-sdk imports, each
// bound to `undefined`.
//
// That is exactly the semantics the webpack build gives the same code via
// `resolve.alias: { "@x402/core": false, … }`: the import succeeds, every
// named binding is `undefined`, and anything that actually *calls* into the
// x402 surface throws at that point. The x402 code path was part of the
// removed HSP flow and is never invoked by ACP.ai (verified under the
// previous webpack dev server), so the bindings simply stay inert.
//
// DO NOT turn these into real implementations. Keeping them `undefined`
// guarantees any accidental use fails loudly instead of silently pretending
// to work.
//
// Name list generated from:
//   grep -rn 'from "@x402' node_modules/@coinbase/cdp-sdk/_esm/ \
//     node_modules/@base-org/account/dist/
export const toClientEvmSigner = undefined;
export const BUILDER_CODE_PATTERN = undefined;
export const BUILDER_CODE_SCHEMA = undefined;
export const BUILDER_CODE = undefined;
export const builderCodeResourceServerExtension = undefined;
export const BuilderCodeClientExtension = undefined;
export const x402ResourceServer = undefined;
export const x402HTTPResourceServer = undefined;
export const HTTPFacilitatorClient = undefined;
export const x402Client = undefined;
export const BatchSettlementEvmScheme = undefined;
export const ExactEvmScheme = undefined;
export const ExactEvmSchemeV1 = undefined;
export const UptoEvmScheme = undefined;
export const ExactSvmScheme = undefined;
export const ExactSvmSchemeV1 = undefined;
export const bazaarResourceServerExtension = undefined;
