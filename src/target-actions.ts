import type { CeServiceActionDefinition } from '@xtrape/connector';
import type { CheckpointVersionId } from '@xtrape/contracts';
import { WidgetActionError } from './errors.js';
import { withFieldTitles } from './actions.js';
import type { TargetFacts, TargetStore } from './target-store.js';

/**
 * The entry Action that CONFIGURES this Widget's one Forgejo target
 * (forgejo-ops#32; owner ruling 2026-09-05: business configuration lives in
 * an Action, env only carries what needs a restart). Three governed
 * operations on the Service itself — their Resource is the Service, not a
 * repository, so they ride the service-target extractor:
 *
 *   manageTarget READ_ONLY the ENTRY: the target as a list of one (URL, when,
 *                          by which route; the credential only as "present"),
 *                          with Test / Edit as row operations
 *   testTarget  READ_ONLY  probe the CURRENT target with its credential
 *   setTarget   MUTATING   replace URL and/or credential; the credential is
 *                          a protected field (RFC-0008 writeOnly +
 *                          x-xtrape-sensitive): blank on edit keeps; the new
 *                          pair is PROBED before it is stored, so a typo
 *                          never replaces a working target
 *
 * The credential is never returned by any of them.
 */
export interface TargetProbe {
  reachable: boolean;
  /** The credential was accepted by Forgejo (200, or 403 = valid token without `read:user` scope). 401 = rejected. */
  credentialAccepted?: boolean;
  version?: string;
  login?: string;
  error?: string;
}

const TARGET_INPUT = {
  baseUrl: { type: 'string', minLength: 1, maxLength: 2048, description: 'Forgejo base URL, e.g. https://forgejo.example (no trailing slash needed).' },
  collaborationToken: {
    type: 'string', format: 'password', writeOnly: true, 'x-xtrape-sensitive': true,
    description: 'Forgejo access token of the collaboration identity. Rides the Platform only ephemerally; stored in this Widget (0600) and never shown again; leave blank on edit to keep the current one.',
  },
} as const;

export async function probeTarget(baseUrl: string, token: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<TargetProbe> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `token ${token}`, accept: 'application/json' };
  try {
    const v = await fetchImpl(`${base}/api/v1/version`, { headers, ...(signal ? { signal } : {}) });
    if (!v.ok) return { reachable: false, error: `GET /api/v1/version answered ${v.status}` };
    const version = ((await v.json()) as { version?: string }).version;
    // /api/v1/user: 200 = accepted (+login); 403 = a VALID token that lacks
    // `read:user` (a read:repository-only collaboration token, the m1 fixture's
    // shape) — accepted; 401 = rejected. Anything else is reported as-is.
    const u = await fetchImpl(`${base}/api/v1/user`, { headers, ...(signal ? { signal } : {}) });
    if (u.status === 401) return { reachable: true, credentialAccepted: false, ...(version ? { version } : {}), error: 'the credential is not accepted: GET /api/v1/user answered 401' };
    if (u.status === 403) return { reachable: true, credentialAccepted: true, ...(version ? { version } : {}) };
    if (!u.ok) return { reachable: true, credentialAccepted: false, ...(version ? { version } : {}), error: `GET /api/v1/user answered ${u.status}` };
    const login = ((await u.json()) as { login?: string }).login;
    return { reachable: true, credentialAccepted: true, ...(version ? { version } : {}), ...(login ? { login } : {}) };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The entry's list-as-console shape (the same display the Panel renders for every `manage X`). */
export function targetListDisplay(facts: TargetFacts | null): Record<string, unknown> {
  return {
    title: 'Forgejo Target',
    data: facts ? [{ id: 'target', ...facts }] : [],
    columns: [
      { key: 'baseUrl', label: 'Forgejo', format: 'code', copyable: true },
      { key: 'hasCollaborationToken', label: 'Credential', format: 'boolean' },
      { key: 'source', label: 'Configured via', format: 'code' },
      { key: 'configuredAt', label: 'Configured at' },
    ],
    rowActions: [
      { label: 'Test', action: 'testTarget', submitLabel: 'Test', payload: {}, showResult: true },
      { label: 'Edit', action: 'setTarget', submitLabel: 'Save', payload: { baseUrl: '$row.baseUrl' } },
    ],
    pageActions: facts ? [] : [{ label: 'Configure', action: 'setTarget', submitLabel: 'Save', payload: {}, variant: 'primary' }],
  };
}

export function buildTargetCeActions(deps: {
  store: TargetStore;
  refFor: (actionName: string) => CheckpointVersionId;
  exposed: (checkpointId: string) => boolean;
  fetchImpl?: typeof fetch;
}): CeServiceActionDefinition[] {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out: CeServiceActionDefinition[] = [];
  // The description travels at the schema root too (Widget Design Conventions
  // §5): the admitted schema bytes are all an AI host sees (exposure#48).
  const add = (a: CeServiceActionDefinition) => {
    if (!deps.exposed(a.checkpoint!.checkpointId)) return;
    out.push({ ...a, inputSchema: { title: a.label, description: a.description, ...withFieldTitles(a.inputSchema as Record<string, unknown>) } });
  };

  // The ENTRY (Widget Design Conventions §2, owner 2026-09-06): one `manage X`
  // per element cluster, opened as a LIST that is the console — here a list
  // of exactly one row (the single-target invariant), with Test and Edit as
  // row operations and Configure as the page operation when nothing is set.
  // Sub-operations are hidden (`_target`), each behind its own Checkpoint.
  add({
    name: 'manageTarget', label: 'Manage Forgejo Target', category: 'target',
    description: 'The Forgejo this Widget points at, as a list of one: URL, when it was configured and by which route, whether a credential is present. Test and Edit from the row; the credential is never shown.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    checkpoint: deps.refFor('manageTarget'),
    execute: async () => ({ success: true, data: { configured: deps.store.facts() !== null, list: targetListDisplay(deps.store.facts()) } }),
  });

  add({
    name: 'testTarget', label: 'Test Forgejo Target', category: '_target',
    description: 'Probe the configured Forgejo with its collaboration credential: version, and the identity the credential resolves to.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    checkpoint: deps.refFor('testTarget'),
    execute: async (_input, context) => {
      const t = deps.store.current();
      if (!t) throw new WidgetActionError('PRECONDITION_FAILED', 'no Forgejo target is configured; run setTarget first');
      // A test that finds a broken target has SUCCEEDED as a test: the facts
      // are the answer (an unreachable host or a rejected credential are
      // reported in `data`, not turned into a failed command).
      const probe = await probeTarget(t.baseUrl, t.collaborationToken, fetchImpl, context?.signal);
      return { success: true, data: { baseUrl: t.baseUrl, ...probe } };
    },
  });

  add({
    name: 'setTarget', label: 'Set Forgejo Target', category: '_target',
    description: 'Point this Widget at a Forgejo: base URL plus the collaboration credential (blank keeps the current one). The pair is probed before it is stored; a pair that does not answer replaces nothing.',
    inputSchema: { type: 'object', properties: TARGET_INPUT, required: ['baseUrl'], additionalProperties: false },
    checkpoint: deps.refFor('setTarget'),
    execute: async (input, context) => {
      const rec = (input ?? {}) as Record<string, unknown>;
      const baseUrl = typeof rec['baseUrl'] === 'string' ? rec['baseUrl'].trim() : '';
      if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new WidgetActionError('VALIDATION_FAILED', 'baseUrl must be an http(s) URL');
      const supplied = typeof rec['collaborationToken'] === 'string' ? rec['collaborationToken'].trim() : '';
      const current = deps.store.current();
      const token = supplied || current?.collaborationToken || '';
      if (!token) throw new WidgetActionError('VALIDATION_FAILED', 'collaborationToken is required the first time a target is configured');
      const probe = await probeTarget(baseUrl, token, fetchImpl, context?.signal);
      if (!probe.reachable || !probe.credentialAccepted) {
        throw new WidgetActionError('PRECONDITION_FAILED', `the new target was NOT stored: ${probe.error ?? 'probe failed'}`);
      }
      const facts = deps.store.set({ baseUrl, ...(supplied ? { collaborationToken: supplied } : {}) });
      return { success: true, data: { target: facts, probe } };
    },
  });
  return out;
}
