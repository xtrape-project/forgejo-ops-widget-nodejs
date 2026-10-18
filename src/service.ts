import type { CeServiceActionDefinition } from '@xtrape/connector';
import { buildActionCatalog } from './actions.js';
import type { ForgejoClientProvider } from './credentials.js';
import { checkpointRefFor, isCheckpointExposed, type STATIC_CHECKPOINT_ROWS } from './checkpoints.js';
import { ActionRegistry } from './registry.js';
import { buildTargetCeActions } from './target-actions.js';
import type { TargetStore } from './target-store.js';
import type { ActionDefinition, Capability } from './types.js';

/** The Service's own configuration Actions (forgejo-ops#32) — not in the domain catalog. */
const TARGET_ACTIONS: ReadonlySet<string> = new Set(['manageTarget', 'testTarget', 'setTarget']);

/**
 * The bounded governed surface: the read-only reference reads (#7 trio plus
 * #16's context snapshot), the two #10 collaboration writes, and #16's Phase B
 * Agent development-loop writes (branch, bounded corrective commit, Issue
 * evidence, and the GUARDED merge).
 *
 * Only the Actions that a governed Checkpoint is declared for are served, each
 * bound to its exact immutable Checkpoint. Reads are served by default; every
 * write is served ONLY when the bounded allowlist names it, so an upgrade never
 * widens a deployment's scope on its own and the #10 dual-identity role split is
 * a per-instance allowlist choice. Administration and the unguarded merge stay
 * unserved: the only governed merge is the guarded one. Execution reuses the
 * domain Action's own handler, run against a credential-bound Forgejo client —
 * the Widget adds no Forgejo-specific surface to Panel / Exposure / Telegram;
 * those consume the same governed Checkpoint.
 */

// The Actions the bounded profile governs, keyed by name. These are exactly the
// `action` names in STATIC_CHECKPOINT_ROWS; a mismatch fails fast at build.
const ROW_REACHED_READS: ReadonlySet<string> = new Set(['getRepository', 'listIssues', 'listPullRequests', 'getIssue', 'getPullRequest', 'getPullRequestContext']);
const GOVERNED_READ_ACTIONS: ReadonlyArray<(typeof STATIC_CHECKPOINT_ROWS)[number]['action']> = [
  'listOrganizations',
  'listRepositories',
  'getRepository',
  'listIssues',
  'listPullRequests',
  'getIssue',
  'getPullRequest',
  'getPullRequestContext',
];

// The governed writes: the #10 pair plus the #16 Phase B loop. Kept as its own
// list so the read/write split stays visible where the surface is assembled;
// both lists must live inside STATIC_CHECKPOINT_ROWS' action names
// (checkpointRefFor throws otherwise). Each is served only when the allowlist
// names it (isCheckpointExposed returns false for a write under the default).
const GOVERNED_WRITE_ACTIONS: ReadonlyArray<(typeof STATIC_CHECKPOINT_ROWS)[number]['action']> = [
  'createPullRequest',
  'reviewPullRequest',
  'createBranch',
  'atomicCommitFiles',
  'createIssue',
  'commentIssue',
  'setIssueState',
  'guardedMergePullRequest',
];

/**
 * The capability groups a set of SERVED actions actually belongs to, for the
 * manifest. It reads each served action's TRUE `ActionDefinition.capability`
 * from the catalog — NOT the served CeAction's coarse `category`, which is only
 * the read/write split: `createBranch` and `atomicCommitFiles` are served under
 * `category='collaborate'` but are `forgejo.content` Actions, so deriving the
 * manifest from `category` mislabels them (#18 review 3076).
 */
export function servedCapabilities(actions: ReadonlyArray<{ name: string }>): Capability[] {
  const capabilityByName = new Map(buildActionCatalog().map((a) => [a.name, a.capability] as const));
  return [...new Set(actions.map((a) => (TARGET_ACTIONS.has(a.name) ? 'forgejo.target' : capabilityByName.get(a.name))).filter((c): c is Capability => c !== undefined))].sort();
}

export function buildCeActions(deps: {
  serviceId: string;
  provider: ForgejoClientProvider;
  bounded?: ReadonlySet<string> | null;
  /** The Service's own target configuration (forgejo-ops#32); absent in tests that only exercise the domain set. */
  targetStore?: TargetStore;
  fetchImpl?: typeof fetch;
}): CeServiceActionDefinition[] {
  const bounded = deps.bounded ?? null;
  // The REGISTRY, not a bare map: its compiled ajv validators are the
  // Widget-side half of the two-layer input contract (review 2965 P1-2).
  const registry = new ActionRegistry(buildActionCatalog());

  const actions: CeServiceActionDefinition[] = [];
  for (const [names, category] of [
    [GOVERNED_READ_ACTIONS, 'inspect'],
    [GOVERNED_WRITE_ACTIONS, 'collaborate'],
  ] as const) {
    for (const name of names) {
      const action = registry.get(name);
      if (!action) throw new Error(`governed action "${name}" is not present in the Action catalog`);
      const ref = checkpointRefFor(deps.serviceId, name);
      if (!isCheckpointExposed(ref.checkpointId, bounded)) continue;
      // Reads that take owner/repo(/number) are reached from a list row
      // (panel-ce#193 #9): they stay PUBLISHED and AI-callable but leave the
      // operator catalog — the list-first entries are the catalog.
      const hidden = category === 'inspect' && ROW_REACHED_READS.has(name);
      actions.push(toCeAction(action, ref, deps.provider, hidden ? '_inspect' : category, registry));
    }
  }
  if (deps.targetStore) {
    // The Service's own configuration rides beside the domain set: same
    // exposure rule (reads by default, the write only when named), its own
    // Resource (the Service), no repository gate — there is no repository.
    actions.push(...buildTargetCeActions({
      store: deps.targetStore,
      refFor: (name) => checkpointRefFor(deps.serviceId, name),
      exposed: (id) => isCheckpointExposed(id, bounded),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }));
  }
  return actions;
}

function toCeAction(
  action: ActionDefinition,
  checkpoint: ReturnType<typeof checkpointRefFor>,
  provider: ForgejoClientProvider,
  category: 'inspect' | '_inspect' | 'collaborate',
  registry: ActionRegistry,
): CeServiceActionDefinition {
  return {
    name: action.name,
    label: action.label,
    description: action.description,
    category,
    inputSchema: action.inputSchema,
    checkpoint,
    execute: async (input, context) => {
      // TWO-LAYER input contract (review 2965 P1-2): the Platform enforces
      // the admitted schema's COARSE projection (types/required/closed), and
      // the Widget enforces the FULL Action schema here — enum, min/max,
      // lengths — BEFORE any Forgejo request. Without this leg, a value the
      // projection widened (e.g. review `event` projected enum→string) would
      // reach Forgejo with out-of-vocabulary semantics.
      const client = provider.forProfile(action.credentialProfile);
      const record = registry.validate(action.name, input ?? {});
      // No repository gate (#34, owner 2026-09-07): the Forgejo token's
      // permission decides — a 403 from Forgejo is the refusal, surfaced as
      // the Action's own failure; nothing here pre-judges visibility.
      const data = await action.execute(record, {
        client,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      return { success: true, data };
    },
  };
}
