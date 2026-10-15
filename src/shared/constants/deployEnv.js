// Deployment-target detection.
//
// Free plan (Render) has constraints that differ from a desktop/self-hosted box:
// no root, no port 443, an ephemeral writable disk and a 512 MB cap. Features
// that assume those primitives (MITM, tunnel binaries) must stay off there.

// Render injects `RENDER=true` into every service. Keep the check cheap — it runs
// on module load in both server and client bundles.
export function isRender() {
  if (typeof process === "undefined" || !process.env) return false;
  return !!process.env.RENDER;
}

// True when the current process must not try to bind low ports or manage DNS.
export function isFreeTierContainer() {
  return isRender();
}
