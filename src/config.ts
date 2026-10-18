const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function httpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, query, or fragment`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export interface WidgetConfig {
  transportMode: 'WORLD_A' | 'WORLD_B';
  platformUrl?: string;
  registrationToken?: string;
  callbackToken?: string;
  callbackHost: string;
  callbackPort?: number;
  callbackAddress?: string;
  serviceId: string;
  confDir: string;
  /**
   * Read-only Forgejo target (#7). When both are set the Widget serves the
   * bounded read-only Checkpoints against this Forgejo; when neither is set it
   * runs inert (health only), as before governed Checkpoints existed.
   */
  forgejoBaseUrl?: string;
  collaborationToken?: string;
  /** `FORGEJO_OPS_BOUNDED_CHECKPOINTS` allowlist, parsed by checkpoints.ts. */
  boundedCheckpoints?: string;
  /**
   * The admitted execution-profile record digest the Checkpoints cite.
   * OPTIONAL in World A (the Checkpoint factory discovers the single admitted
   * profile at registration; when set it pins which one). REQUIRED in World B
   * when a Forgejo target is provisioned: a listen-only Widget has no
   * registration and no factory context, so nothing can discover the profile —
   * the operator pins the digest the Platform admitted.
   */
  executionProfileDigest?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WidgetConfig {
  const transportMode = env.FORGEJO_OPS_WIDGET_TRANSPORT_MODE?.trim();
  if (transportMode !== 'WORLD_A' && transportMode !== 'WORLD_B') {
    throw new Error('FORGEJO_OPS_WIDGET_TRANSPORT_MODE must be WORLD_A or WORLD_B as bound by the Widget Token');
  }
  const callbackHost = env.FORGEJO_OPS_WIDGET_CALLBACK_HOST?.trim() || '0.0.0.0';
  const callbackToken = env.FORGEJO_OPS_WIDGET_CALLBACK_TOKEN?.trim() || undefined;
  const insecure = env.FORGEJO_OPS_WIDGET_ALLOW_INSECURE_CALLBACK === 'true';
  if (!callbackToken && (!insecure || !LOOPBACK_HOSTS.has(callbackHost))) {
    throw new Error('FORGEJO_OPS_WIDGET_CALLBACK_TOKEN is required except for explicit loopback-only development');
  }

  const rawPort = env.FORGEJO_OPS_WIDGET_CALLBACK_PORT?.trim();
  const callbackPort = rawPort ? Number(rawPort) : undefined;
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535)) {
    throw new Error('FORGEJO_OPS_WIDGET_CALLBACK_PORT must be an integer from 1 to 65535');
  }

  // Administration credential and destructive execution stay gated. #10
  // unfroze exactly two collaboration writes; administration and destruction
  // remain non-goals, and nothing below un-gates them.
  if (env.FORGEJO_OPS_ADMINISTRATION_TOKEN?.trim()) {
    throw new Error('the administration credential is not accepted: administration is a non-goal (#7; the #10 write pair rides the collaboration credential)');
  }
  if (env.FORGEJO_OPS_ENABLE_DESTRUCTIVE === 'true') {
    throw new Error('destructive execution is a 0.8.7 non-goal (#7); this Widget serves only the bounded governed Checkpoints');
  }
  // Read-only Forgejo target (un-gated for #7). Both must be present together:
  // a URL without a token could serve nothing, a token without a URL has no
  // target. Neither present ⇒ the Widget runs inert (health only).
  const forgejoBaseUrl = env.FORGEJO_OPS_FORGEJO_URL?.trim() || undefined;
  const collaborationToken = env.FORGEJO_OPS_COLLABORATION_TOKEN?.trim() || undefined;
  if (Boolean(forgejoBaseUrl) !== Boolean(collaborationToken)) {
    throw new Error('the read-only Forgejo target needs BOTH FORGEJO_OPS_FORGEJO_URL and FORGEJO_OPS_COLLABORATION_TOKEN (or neither, to run inert)');
  }
  const executionProfileDigest = env.FORGEJO_OPS_EXECUTION_PROFILE_DIGEST?.trim() || undefined;
  if (executionProfileDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(executionProfileDigest)) {
    throw new Error('FORGEJO_OPS_EXECUTION_PROFILE_DIGEST must be sha256:<64 lowercase hex>');
  }
  const platformUrl = env.FORGEJO_OPS_WIDGET_PLATFORM_URL?.trim();
  const registrationToken = env.FORGEJO_OPS_WIDGET_REGISTRATION_TOKEN?.trim();
  const callbackAddress = env.FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS?.trim();
  if (!LOOPBACK_HOSTS.has(callbackHost) && !callbackAddress) {
    throw new Error('non-loopback callback host requires FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS');
  }
  if (transportMode === 'WORLD_A') {
    if (!platformUrl) throw new Error('WORLD_A requires FORGEJO_OPS_WIDGET_PLATFORM_URL');
    if (!registrationToken) throw new Error('WORLD_A requires the Widget Token in FORGEJO_OPS_WIDGET_REGISTRATION_TOKEN');
  } else {
    if (platformUrl || registrationToken) throw new Error('WORLD_B must not receive Platform URL or registration token; it is listen-only');
    if (!callbackToken) throw new Error('WORLD_B requires its service-issued callback token');
    if (!callbackAddress) throw new Error('WORLD_B requires the operator-vouched FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS');
    if (callbackPort === undefined) throw new Error('WORLD_B requires a fixed FORGEJO_OPS_WIDGET_CALLBACK_PORT');
    // A listen-only Widget has no registration, so no Checkpoint FACTORY and
    // no way to discover the admitted execution profile (Connector 0.8.5
    // refuses a factory in listen-only mode). The governed read profile in
    // World B therefore needs the operator to pin the admitted digest; the
    // definitions then ride the authenticated descriptor as a plain array.
    // Since forgejo-ops#32 the Widget is governed whether or not a target is
    // configured yet (the target.* Checkpoints are how it gets one), so the
    // pin is unconditional in World B.
    if (executionProfileDigest === undefined) {
      throw new Error(
        'WORLD_B requires FORGEJO_OPS_EXECUTION_PROFILE_DIGEST: a listen-only Widget cannot discover the admitted execution profile, so the operator pins the digest the Platform admitted',
      );
    }
  }
  return {
    transportMode,
    ...(platformUrl ? { platformUrl: httpUrl(platformUrl, 'FORGEJO_OPS_WIDGET_PLATFORM_URL') } : {}),
    ...(registrationToken ? { registrationToken } : {}),
    ...(callbackToken ? { callbackToken } : {}),
    callbackHost,
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(callbackAddress
      ? { callbackAddress: httpUrl(callbackAddress, 'FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS') }
      : {}),
    serviceId: env.FORGEJO_OPS_WIDGET_SERVICE_ID?.trim() || 'forgejo-ops-widget-nodejs',
    confDir: env.FORGEJO_OPS_WIDGET_CONF_DIR?.trim() || './conf',
    ...(forgejoBaseUrl ? { forgejoBaseUrl: httpUrl(forgejoBaseUrl, 'FORGEJO_OPS_FORGEJO_URL') } : {}),
    ...(collaborationToken ? { collaborationToken } : {}),
    ...(env.FORGEJO_OPS_BOUNDED_CHECKPOINTS !== undefined ? { boundedCheckpoints: env.FORGEJO_OPS_BOUNDED_CHECKPOINTS } : {}),
    ...(executionProfileDigest ? { executionProfileDigest } : {}),
  };
}
