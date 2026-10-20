// Applies patches/ via patch-package after installs.
//
// Skips (exit 0) when patch-package isn't installed — production runtime images install
// with --omit=dev (Dockerfile:45) and don't need the patches. The only patch today,
// patches/next+16.3.8.patch, has a dev-only part (its writer change is gated on
// Turbopack's dev flag; readers no-op on stock manifests) and a production part
// (setManifestsSingleton reuses its server-actions copy). The production part is
// bundled into .next at build time, and the build stage installs dev deps, so the
// runtime install doesn't need to re-apply it. Fails loudly when patch-package IS
// present but a patch no longer applies — that's the tripwire on Next upgrades:
// re-validate the patched functions and regenerate the patch, don't skip it
// (losing it silently brings back the dev-server manifest OOM; see
// docs/architecture/package-build-system.md "Server-action barrels & the RSC manifest").
//
// Note: `npm run install:ignore` (--ignore-scripts) bypasses this — run
// `npx patch-package` manually afterwards.
let bin;
try {
  bin = require.resolve('patch-package/dist/index.js');
} catch {
  console.log('[postinstall] patch-package not installed (prod/omit=dev install) — skipping patches/');
  process.exit(0);
}
const { spawnSync } = require('child_process');
const result = spawnSync(process.execPath, [bin], { stdio: 'inherit' });
process.exit(result.status ?? 1);
