import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgejoTarget } from './types.js';

/**
 * The Widget's ONE Forgejo target as runtime state (forgejo-ops#32).
 *
 * Owner ruling 2026-09-05: a Service's business configuration is set through
 * its entry Action; env carries only what needs a restart to take effect.
 * The target — base URL + collaboration credential — needs no restart, so it
 * lives here: a JSON file under the conf directory, mode 0600 (the same
 * transitional posture as linux-ops' server store), written atomically and
 * read at call time by the client provider so `manageTarget.set` takes
 * effect on the next invocation.
 *
 * Single-target invariant (#19) unchanged: one Service = one target; `set`
 * REPLACES the target this Service addresses, it does not add a second one.
 *
 * The two env variables remain as a FIRST-BOOT seed only: when the store is
 * empty at startup they are imported once (linux-ops' provisioned-file
 * semantics); afterwards the store is the authority and env is ignored.
 * The credential never leaves this process except toward Forgejo.
 */
export interface StoredTarget {
  baseUrl: string;
  collaborationToken: string;
  configuredAt: string;
  /** How the current value arrived: the env seed, or a governed manageTarget.set. */
  source: 'env-seed' | 'action';
}

export interface TargetFacts {
  baseUrl: string;
  configuredAt: string;
  source: StoredTarget['source'];
  hasCollaborationToken: boolean;
}

export class TargetStore {
  private readonly file: string;
  private cached: StoredTarget | null | undefined;

  constructor(private readonly confDir: string, private readonly serviceId: string) {
    this.file = join(confDir, 'forgejo-target.json');
  }

  /** The current target, or null when none is configured. */
  current(): StoredTarget | null {
    if (this.cached !== undefined) return this.cached;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredTarget>;
      if (typeof parsed.baseUrl !== 'string' || typeof parsed.collaborationToken !== 'string') {
        throw new Error(`${this.file} is not a stored Forgejo target`);
      }
      try { chmodSync(this.file, 0o600); } catch { /* defense-in-depth; the write below sets it */ }
      this.cached = {
        baseUrl: parsed.baseUrl,
        collaborationToken: parsed.collaborationToken,
        configuredAt: typeof parsed.configuredAt === 'string' ? parsed.configuredAt : 'unknown',
        source: parsed.source === 'action' ? 'action' : 'env-seed',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cached = null;
    }
    return this.cached;
  }

  /** What may be shown: everything but the credential (only its presence). */
  facts(): TargetFacts | null {
    const t = this.current();
    return t ? { baseUrl: t.baseUrl, configuredAt: t.configuredAt, source: t.source, hasCollaborationToken: t.collaborationToken.length > 0 } : null;
  }

  /** The client-facing shape the actions run against, or null when unconfigured. */
  asForgejoTarget(): ForgejoTarget | null {
    const t = this.current();
    return t ? { id: this.serviceId, baseUrl: t.baseUrl, credentials: { collaboration: t.collaborationToken } } : null;
  }

  /**
   * Replace the target. `collaborationToken` undefined/blank = keep the
   * current credential (the sensitive-field convention: blank on edit keeps);
   * on a first configuration it is required.
   */
  set(input: { baseUrl: string; collaborationToken?: string }, source: StoredTarget['source'] = 'action'): TargetFacts {
    const current = this.current();
    const token = input.collaborationToken?.trim() || current?.collaborationToken;
    if (!token) throw new Error('a collaboration token is required to configure the Forgejo target for the first time');
    const next: StoredTarget = { baseUrl: input.baseUrl.replace(/\/+$/, ''), collaborationToken: token, configuredAt: new Date().toISOString(), source };
    mkdirSync(this.confDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* mode set on create */ }
    renameSync(tmp, this.file);
    this.cached = next;
    return this.facts()!;
  }

  /** First-boot import of the env pair; a no-op once anything is stored. */
  seedFromEnv(baseUrl: string | undefined, collaborationToken: string | undefined): 'seeded' | 'kept' | 'none' {
    if (this.current()) return 'kept';
    if (!baseUrl || !collaborationToken) return 'none';
    this.set({ baseUrl, collaborationToken }, 'env-seed');
    return 'seeded';
  }
}
