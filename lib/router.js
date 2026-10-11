export function isImageRequest(body = {}) {
  return (body.messages || []).some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part && (part.type === "image_url" || part.type === "input_image"))
  );
}

export function eligible(provider, needsImage = false, now = Date.now()) {
  if (!provider || provider.enabled !== true || !provider.endpoint_url) return false;
  if (provider.quarantined === true || Number(provider.failures || 0) >= 5) return false;
  if (provider.health_status && !["healthy", "unknown"].includes(provider.health_status)) return false;
  if (provider.cooldown_until && new Date(provider.cooldown_until).getTime() > now) return false;
  if (provider.quota_remaining !== null && provider.quota_remaining !== undefined && Number(provider.quota_remaining) <= 0) return false;
  if (needsImage && !(provider.capabilities || {}).image) return false;
  return true;
}

export function chooseProvider(providers, stickyProviderId, needsImage = false, now = Date.now()) {
  const candidates = providers
    .filter((p) => eligible(p, needsImage, now))
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));

  if (!candidates.length) return { provider: null, reason: "no_eligible_provider" };
  const primary = candidates[0];
  const sticky = candidates.find((p) => p.id === stickyProviderId);
  // Sticky selection is preserved while healthy; when a higher-priority provider
  // recovers, automatically fail back to it.
  if (sticky && Number(sticky.priority || 100) <= Number(primary.priority || 100)) {
    return { provider: sticky, reason: "sticky" };
  }
  return { provider: primary, reason: sticky ? "failback" : "primary" };
}

export function nextFailureState(provider) {
  const failures = Number(provider.failures || 0) + 1;
  return {
    failures,
    quarantined: failures >= 5,
    health_status: failures >= 5 ? "quarantined" : "degraded",
    cooldown_until: new Date(Date.now() + Math.min(60_000 * failures, 5 * 60_000)).toISOString()
  };
}

export function nextSuccessState() {
  return { failures: 0, quarantined: false, health_status: "healthy", cooldown_until: null };
}
