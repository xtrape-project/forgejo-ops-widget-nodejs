/**
 * Resolve the Service ID a World-B provisioning run must use.
 *
 * It MUST equal the DEPLOYED Widget's Service ID. The operator admits the
 * resource-extractor artifacts this Service ID produces, and the deployed
 * descriptor's Checkpoint definitions reference those artifacts by a digest
 * derived from that same Service ID (checkpoints.ts, #19). Provisioning under
 * any other Service ID admits artifacts whose digest the deployed definitions
 * never cite — every governed read is then unresolvable Platform-side.
 *
 * Unlike the Widget's own runtime resolution (`FORGEJO_OPS_WIDGET_SERVICE_ID ||
 * DEFAULT_SERVICE_ID`), there is deliberately **no default here**. A
 * provisioning run reads the Service ID from the same source the deployment
 * sets — an explicit argument, or the deployment's
 * `FORGEJO_OPS_WIDGET_SERVICE_ID` — and **fails closed** when neither is
 * present. That is the fix for the gap review #3092 found: an operator running
 * the provisioning command in a bare shell (no argument, `FORGEJO_OPS_WIDGET_SERVICE_ID`
 * unset) could otherwise silently fall back to the package default and provision
 * the wrong Service ID against a custom-Service-ID deployment.
 */
export type ProvisioningServiceIdSource = 'argument' | 'FORGEJO_OPS_WIDGET_SERVICE_ID';

export function resolveProvisioningServiceId(input: {
  arg?: string | undefined;
  env?: string | undefined;
}): { serviceId: string; source: ProvisioningServiceIdSource } {
  const arg = input.arg?.trim() || undefined;
  const env = input.env?.trim() || undefined;
  if (arg) return { serviceId: arg, source: 'argument' };
  if (env) return { serviceId: env, source: 'FORGEJO_OPS_WIDGET_SERVICE_ID' };
  throw new Error(
    'refusing to print provisioning artifacts without an explicit Service ID (#19). ' +
      'A World-B provisioning run must bind the EXACT deployed Service ID: pass it as the ' +
      "first argument, or run with the deployment's FORGEJO_OPS_WIDGET_SERVICE_ID set. " +
      'Silently using the package default would admit artifacts the deployed descriptor ' +
      'does not reference.',
  );
}
