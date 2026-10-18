import { createForgejoOpenApiClient, type ForgejoOpenApiClient } from '@xtrape/forgejo-api';
import { WidgetActionError } from './errors.js';
import type { CredentialProfile, ForgejoTarget } from './types.js';

/**
 * Produces credential-bound clients. Profile selection is exact: an ordinary
 * operation can never fall through to the administration credential, and a
 * missing administration credential fails before a request is constructed.
 */
export class ForgejoClientProvider {
  private readonly resolve: () => ForgejoTarget | null;

  /**
   * The target is read AT CALL TIME (forgejo-ops#32): pass a resolver (the
   * TargetStore's view) so a governed `setTarget` takes effect on the next
   * invocation without a restart; a fixed target is still accepted.
   */
  constructor(target: ForgejoTarget | (() => ForgejoTarget | null), private readonly fetchImpl: typeof fetch = fetch) {
    this.resolve = typeof target === 'function' ? target : () => target;
  }

  private target(): ForgejoTarget {
    const t = this.resolve();
    if (!t) throw new WidgetActionError('PRECONDITION_FAILED', 'no Forgejo target is configured for this Widget; run setTarget (forgejo-ops#32)');
    return t;
  }

  hasProfile(profile: CredentialProfile): boolean {
    const t = this.resolve();
    if (!t) return false;
    return profile === 'collaboration' || t.credentials.administration !== undefined;
  }

  forProfile(profile: CredentialProfile): ForgejoOpenApiClient {
    const target = this.target();
    const credential = target.credentials[profile];
    if (!credential) throw new Error(`Forgejo credential profile "${profile}" is not configured`);
    return createForgejoOpenApiClient({
      baseUrl: target.baseUrl,
      authScheme: 'token',
      credential,
      fetch: this.fetchImpl,
    });
  }
}
