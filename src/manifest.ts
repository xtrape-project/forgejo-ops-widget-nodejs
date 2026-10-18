import { CE_CONTRACT_VERSION, type ServiceManifest } from '@xtrape/contracts';

export const FORGEJO_OPS_WIDGET_VERSION = '0.8.7';
export const DEFAULT_SERVICE_ID = 'forgejo-ops-widget-nodejs';

export function buildManifest(
  serviceId = process.env.FORGEJO_OPS_WIDGET_SERVICE_ID?.trim() || DEFAULT_SERVICE_ID,
  options: {
    /**
     * The capability groups THIS deployment ACTUALLY serves, derived from the
     * governed Checkpoints exposed at startup (index.ts maps the served
     * CeActions' categories). An empty/absent set means the Widget runs inert
     * (health only). The manifest states what this deployment runs, not what the
     * repository owns — and it must track the served surface: a deployment whose
     * allowlist exposes the #10/#16 writes serves `forgejo.collaborate`, so the
     * manifest can no longer claim a read-only surface (#18 review 3075).
     */
    servedCapabilities?: readonly string[];
  } = {},
): ServiceManifest {
  const served = [...new Set(options.servedCapabilities ?? [])].sort();
  const inert = served.length === 0;
  const servesWrites = served.some((c) => c !== 'forgejo.inspect');
  return {
    contractVersion: CE_CONTRACT_VERSION,
    tenant: 'default',
    service: {
      id: serviceId,
      name: 'forgejo-ops-widget',
      version: FORGEJO_OPS_WIDGET_VERSION,
      description: inert
        ? 'Forgejo Widget transport and health bootstrap; domain Actions remain withheld pending target provisioning.'
        : servesWrites
          ? 'Forgejo Widget serving the bounded governed Checkpoints this deployment exposes: read Checkpoints (repository / issue / pull-request) plus the governed writes the operator allowlist names — branch, bounded corrective commit, Issue evidence, pull-request create/review, and the guarded merge.'
          : 'Forgejo Widget serving the bounded read-only governed Checkpoints (repository / issue / pull-request metadata); writes are served only when the operator allowlist names them.',
    },
    runtime: { language: 'nodejs', agent: '@xtrape/connector' },
    // Advertise only capability groups with SERVED Checkpoints in THIS
    // deployment. Repository ownership is broader than runtime availability, and
    // so is the served surface: reads are the default, and a write group appears
    // only when the operator allowlist exposes one. When nothing domain-level is
    // served, the non-domain bootstrap capability alone (the 0.8.x manifest
    // requires at least one capability).
    capabilities: inert ? ['forgejo.bootstrap'] : served,
    message: { supportedTypes: ['QUERY', 'SUMMARY'] },
  };
}
