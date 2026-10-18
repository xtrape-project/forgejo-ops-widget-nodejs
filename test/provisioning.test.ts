import { describe, it, expect } from 'vitest';
import { resolveProvisioningServiceId } from '../src/provisioning.js';
import { resourceArtifacts } from '../src/checkpoints.js';

// The World-B provisioning gap review #3092 flagged: the operations command
// could silently provision the package-default Service ID against a deployment
// running a custom FORGEJO_OPS_WIDGET_SERVICE_ID, and the script's internal
// self-check could not catch it (both paths shared the same wrong id). The fix
// binds the EXACT deployed Service ID and fails closed otherwise.
describe('World-B provisioning binds the exact deployed Service ID (#19, review #3092)', () => {
  it('uses an explicit argument', () => {
    expect(resolveProvisioningServiceId({ arg: 'deployed-x', env: undefined })).toEqual({
      serviceId: 'deployed-x',
      source: 'argument',
    });
  });

  it('uses the deployment FORGEJO_OPS_WIDGET_SERVICE_ID when no argument', () => {
    expect(resolveProvisioningServiceId({ arg: undefined, env: 'deployed-y' })).toEqual({
      serviceId: 'deployed-y',
      source: 'FORGEJO_OPS_WIDGET_SERVICE_ID',
    });
  });

  it('an explicit argument wins over the env', () => {
    expect(resolveProvisioningServiceId({ arg: 'arg-id', env: 'env-id' }).serviceId).toBe('arg-id');
  });

  it('FAILS CLOSED when neither is set — never silently defaults (the #3092 gap)', () => {
    expect(() => resolveProvisioningServiceId({ arg: undefined, env: undefined })).toThrow(/explicit Service ID/);
    expect(() => resolveProvisioningServiceId({ arg: '  ', env: '' })).toThrow(/explicit Service ID/);
  });

  it('a custom Service ID provisions a DISTINCT artifact digest — the misprovisioning it prevents is observable', () => {
    const custom = resolveProvisioningServiceId({ arg: 'custom-deploy', env: undefined }).serviceId;
    const dflt = 'forgejo-ops-widget-nodejs';
    expect(custom).not.toBe(dflt);
    // Provisioning under the wrong id would admit a different digest than the
    // deployed descriptor cites — exactly the mismatch #19 must prevent.
    expect(resourceArtifacts(custom)[0]!.digest).not.toBe(resourceArtifacts(dflt)[0]!.digest);
  });
});
