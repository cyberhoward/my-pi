# Guided runner setup

Outcome: `/runners setup` guides configuration without requiring infrastructure JSON. All discovery is read-only; no cloud resources, workflow files, credentials, SSH installations, or legacy policies are modified by the wizard. Existing controller snapshots are not redeployed. Engineering verification uses fixtures only.

## Steps

1. Explain configuration versus activation and existing controller behavior. Preserve legacy policies by default; replacing them requires an explicit identity/billing warning.
2. Select repository or shared organization scope. Organization scope requires an exact repository allowlist and selected runner group. An installed remote controller prevents changing its installation scope.
3. Check credential availability, explain environment/`gh auth` setup without collecting or saving tokens, and offer retry or a clearly unvalidated configuration-only path.
4. Discover compatible x86 Hetzner locations, server types, system images, and existing restrictive firewalls. Do not create a firewall. Configure named pools with quantities 0–3, routing labels, and editable infrastructure choices.
5. Preserve valid runner pins; offer the official stable Linux x64 release only when the exact asset has a verified SHA-256 digest. Manual pin entry is an explicit fallback, never a fabricated default.
6. Explain idle expiry, polling, and optional startup prewarming. Quote live EUR compute and public-IP costs using the same calculation and maximum lifetime rule as core preflight. Positive accepted caps are required for activation; estimates exclude VAT and variable traffic and are not account-wide limits.
7. Review scope, paths, pool mappings, pins, workflow labels, timings, cost caps, and legacy/remote implications. Back/cancel does not persist draft changes. Unresolved pools can become disabled drafts only with explicit consent.
8. Save disabled configuration by default. Separate Save and enable local automation requires fresh read-only preflight plus explicit cost and sole-writer confirmations. Never offer local activation for an installed remote controller. Detect concurrent settings edits before saving; rebind runtime only after saving.

## Work ownership

- Contract: `setup-types.ts` exposes normalized read-only discovery, credentials, release, quote, and validation methods.
- Service worker: `setup-services.ts`, `src/setup-discovery.ts`, shared provider cost/firewall helpers, provider refactors, and focused service tests. No UI or Git operations.
- Wizard worker: `setup.ts`, `setup-screen.ts` if useful, focused wizard tests. Consume the contract; no provider, integration, or Git edits.
- Integration: command/menu entrypoints, advanced-settings navigation, persistence hardening if needed, docs and integration tests after workers finish.
- Coordinator: inspect changes, build before full test suite, installed Pi loader smoke, independent read-only review, fixes, commit and push `my-pi/main` only.

## Verification

Fixture coverage: GET-only bounded discovery, malformed/missing prices or release digest, credentials and exact scope, restrictive firewalls, quantities and multiple sizes, generated reruns, legacy retention/replacement, remote restrictions, cancel/back, explicit activation, concurrent configuration edits, and private settings permissions. Build/typecheck and full extension suite must pass. No live cloud/SSH/API verification and no changes in the unrelated `my-gratitude` checkout.

Final evidence: build and typecheck passed; 317 tests across 34 files passed, including 40 wizard regressions. Installed Pi loaded both source and compiled entrypoints and their noninteractive lifecycle handlers. The curated reaper archive loaded headlessly without Pi peers. Independent service/core and integrated reviews reported no remaining P1/P2 findings after fixes. Discovery and activation support the Ubuntu 24.04 system image; other distributions are deliberately excluded until their bootstrap dependencies are supported.
