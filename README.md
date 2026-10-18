# forgejo-ops-widget-nodejs

Official Xtrape **Widget** for Forgejo capabilities, implemented in Node.js.

This is the single Forgejo Capability owner. The former proposal to split
ordinary collaboration into `forgejo-api-widget-nodejs` and administrative
operations into this repository is retired before implementation: risk is a
Checkpoint and policy property, not by itself a Widget boundary.

## Product boundary

| Role | What it is here |
| --- | --- |
| **Widget** | This repository: the deployable/runnable Artifact. |
| **Service** | What starting the Widget produces; default logical Service ID `forgejo-ops-widget-nodejs`. |
| **Worker** | Each running process of the Service. |
| **Connector** | `@xtrape/connector`, used by the Worker to connect to the Platform. |
| **Component** | `@xtrape/forgejo-api`, the transport-neutral Forgejo HTTP client. |
| **Resource** | Forgejo instances, organizations, repositories, branches, issues, pull requests, releases, users, teams, webhooks, and runners. |

The Widget owns Forgejo semantics as governed Xtrape Capabilities, Actions, and
Checkpoints. It does not own Forgejo HTTP mechanics, Platform authorization, or
MCP projection.

## Capabilities

One Widget groups operations by semantic function rather than creating a second
Widget for each risk tier:

| Capability | Examples |
| --- | --- |
| `forgejo.inspect` | repository, branch, issue, pull request, diff, review, and document reads |
| `forgejo.collaborate` | comments, reviews, ordinary issue and pull-request collaboration |
| `forgejo.content` | branch creation and bounded file/commit workflows |
| `forgejo.governance` | merge, release, label/milestone definition, protection, and destructive repository operations |
| `forgejo.administration` | organization, repository, user, team, webhook, runner, and instance administration |

Every externally meaningful operation has exactly one Action and one versioned
Checkpoint identity. Mixed operations such as the legacy `updatePullRequest`
wire tool are split into explicit Actions; compatibility routing belongs to
Xtrape Exposure and a request that mixes incompatible effects fails closed.

## Credential profiles

One Widget does **not** mean one all-powerful credential for every Action.

| Profile | May be used by |
| --- | --- |
| `collaboration` | inspection and, after governed mutation transport exists, comments, reviews, merge, and bounded ordinary repository work |
| `administration` | governance, destructive, bulk, release, and instance administration |

Each inventory entry declares the least-privileged credential profile it needs;
ordinary merge is a collaboration operation, not administration. An ordinary
Action must never receive the administration credential. The current runtime
accepts only the `collaboration` credential, used by the governed reads and
the #10 write pair alike; the `administration` credential is rejected because
no administration Action is served.

Deployments that require process-level isolation may run restricted profiles
of the same reviewed Widget Artifact with distinct Service identities and
credentials. That is a deployment security choice, not two independently owned
Widget products or duplicated implementations.

## Authority boundaries

- The **Platform** decides exposure, Account entitlement, authorization,
  approval, target admission, invocation, and authoritative audit.
- This Widget applies Forgejo-specific validation and local safety controls;
  local policy may only narrow or deny Platform authority.
- `forgejo-api-component-nodejs` owns typed HTTP requests and Forgejo API error
  normalization. Consuming it grants no Xtrape capability.
- Xtrape Exposure owns MCP sessions, compatibility projection, and tool names.
- No raw `request`, shell, or arbitrary endpoint Action is allowed.

## Migration source

`infra/mcp-forgejo-nodejs` remains the bounded transitional production profile.
Its code is migrated into three destinations:

1. transport-neutral HTTP mechanics -> `forgejo-api-component-nodejs`;
2. all governed Forgejo operations -> this Widget;
3. MCP transport and compatibility projection -> `xtrape-exposure`.

Migrate first and retire the transitional profile only after Checkpoint-level
integration evidence exists.

## Implemented runtime slice

The Node 24 runtime connects through `@xtrape/connector@0.8.5` and consumes the
published, exact `@xtrape/forgejo-api@0.8.0` package.

**Bounded reference profile (#7 reads + #10 writes + #16 Phase B).** When a
Forgejo target is provisioned (see Runtime configuration), the deployed CE
runtime serves the bounded read-only reference reads (the non-host,
lower-side-effect reference domain of docs#262 H1), the two collaboration
writes #10 unfroze for the dual-instance dual-identity plan, and #16's Phase B
Agent development loop — the writes that carry a task from a working branch
through a bounded corrective commit, Issue evidence and a **guarded** merge:

| Checkpoint | Action | Resource | sideEffect / risk |
| --- | --- | --- | --- |
| `repository.get@1.0.2` | `getRepository` | service → owner → repository | `READ_ONLY` / `LOW` |
| `issue.get@1.0.2` | `getIssue` | service → owner → repository | `READ_ONLY` / `LOW` |
| `pull-request.get@1.0.2` | `getPullRequest` | service → owner → repository | `READ_ONLY` / `LOW` |
| `pull-request.context.get@1.0.1` | `getPullRequestContext` | service → owner → repository | `READ_ONLY` / `LOW` |
| `pull-request.create@1.0.1` | `createPullRequest` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `pull-request-review.create@1.0.1` | `reviewPullRequest` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `branch.create@1.0.1` | `createBranch` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `pull-request.change.commit@1.0.1` | `atomicCommitFiles` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `issue.create@1.0.1` | `createIssue` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `issue-comment.create@1.0.1` | `commentIssue` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `issue.state.set@1.0.1` | `setIssueState` | service → owner → repository | `MUTATING` / `MEDIUM` |
| `pull-request.merge.guarded@1.0.1` | `guardedMergePullRequest` | service → owner → repository | `MUTATING` / `HIGH` |

**The reads are served by default; every write is explicit opt-in**: with
`FORGEJO_OPS_BOUNDED_CHECKPOINTS` absent only the reads are served, and a write
is exposed only when the allowlist names it — so an upgrade never widens a
deployment's scope on its own, and the #10 dual-identity role split is a
per-instance allowlist choice (author names branch/commit/PR/issue/guarded
merge; reviewer names review + evidence). **Whether a write may land is the
Forgejo token's permission** (#34, owner ruling 2026-09-07): no row pre-judges
repository visibility — a Forgejo 403 is the refusal, surfaced as the write's
own failure — and which repositories a session may reach at all is the
Platform's exposure rule / entitlement. The 1.0.0 writes carried a
`repository-proven-public` gate (a classification device from the days the AI
face carried nothing above INTERNAL, never an authorization one); published
preconditions are immutable, so every write is `@1.0.1` now.

The revision stories are honest per operation. `pull-request-review.create`
binds its head **server-side** (`commit_id: expectedHeadRevision`);
`pull-request.create` declares **no** revision pin — Forgejo resolves head/base
by branch ref with no CAS-create and a PR tracks its head branch, so a
create-time SHA pin would be a raceable preflight dressed as a binding (the
result reports the server-resolved head instead). `branch.create` and
`pull-request.change.commit` pin their expected source/branch (and per-file)
revisions and deny protected branches. **`pull-request.merge.guarded` is the
only governed merge — there is no unguarded escape hatch.** It fails closed, at
the Widget, before it POSTs the merge, on: a stale/unexpected head, a PR that is
not open or not mergeable, no approving review bound to the current head (stale
approvals never qualify), any blocking request-changes, or a required status
check that is not green; the merge POST then re-binds the same head server-side
(`head_commit_id`) with `force_merge:false`. It is `HIGH` risk, and Merge
Authority is **not** inferred from authorship or credential — the Widget
declares facts and enforces mechanics; the Platform decides the control
(Confirmation/Approval).

The normalized Resource of every governed Checkpoint is the REPOSITORY: the issue/PR
index is content addressing within it, not a finer authorization grain (and
the static extractor resolves only string pointer values — the integer index
could not be a segment). Per-object granularity, if ever wanted, is future
target-admission work. `@1.0.0` cited the richer Action schemas the Platform's
enforcement subset refuses; a published version is immutable, so the
correction is `@1.0.1`, not an edit.

Each is an exact immutable `@xtrape/contracts` `CheckpointDefinition` binding
its governed Action by `action.actionId`. Delivery differs by direction
(Connector 0.8.5 refuses the wrong combination at startup): **World A**
publishes through the Checkpoint FACTORY on the instance credential at
registration (admitted execution profile discovered, resource-extractor
artifacts + content-addressed schema records published); **World B
(listen-only)** carries the definitions as a plain array in the authenticated
descriptor, built against the operator-pinned
`FORGEJO_OPS_EXECUTION_PROFILE_DIGEST`, with the extractor artifacts admitted
by the operator (`scripts/print-extractor-artifacts.mjs` prints the exact
bytes). Output sensitivity is `INTERNAL` under the owner's classification
rulings (2026-09-06: repository metadata and issue/PR content are INTERNAL —
what the credential can see, Panel = Exposure); the ordinary return path
carries up to its deviceType ceiling (mcp-adapter and panel CONFIDENTIAL
since platform-ce#318). There is no structural public-repository gate any
more (#34): the reads left it on 2026-09-06, the writes on 2026-09-07.
`FORGEJO_OPS_BOUNDED_CHECKPOINTS` narrows the set further and fails closed on
a present-but-empty value. The Widget is governed whether or not a target is
configured yet (#32): the `target.*` Checkpoints are how an operator gives it
one, and the domain reads answer `PRECONDITION_FAILED` until then.

**Every other write remains withheld.** Beyond the governed set above — the
#7/#10/#16 reads and writes — all other mutation / administration / destructive
operations stay unserved, the administration credential is rejected, and
`FORGEJO_OPS_ENABLE_DESTRUCTIVE=true` is refused. In particular the unguarded
`mergePullRequest` action stays **dormant inventory** forever: the only
governed merge is `pull-request.merge.guarded`. The broader Forgejo
control-plane roadmap (repository lifecycle, branch-protection administration,
teams, webhooks, releases, bulk operations) is epic #1 and is **not** part of
this Phase B slice.

The repository also contains a 59-entry schema-bound migration inventory. Apart
from the twelve served Checkpoints above, the inventory is implementation and
disposable-test fixtures only; the served surface is exactly the bounded
governed set. The full inventory covers:

- repository, branch, tag, commit, tree and bounded file inspection;
- label, milestone and release-record inspection;
- issue, comment, pull request, changed-file, commit and review inspection;
- bounded issue creation, comments and label replacement;
- issue metadata, state, assignee and milestone migration paths;
- pull-request creation, metadata update, close and whole-PR review;
- branch creation plus bounded create/update and atomic multi-file migration paths;
- pull-request merge and release creation inventory;
- label and milestone lifecycle plus destructive deletion inventory;
- branch-protection creation/update inventory;
- destructive branch, release-record and repository deletion inventory;
- organization, organization-repository and bounded team membership/access
  administration.

Each inventory entry has a unique versioned Checkpoint coordinate plus closed
input schema, explicit risk, side-effect class, credential profile and local
preconditions. Beyond the twelve governed Checkpoints above, that
metadata is not canonical Platform authorization: the corresponding
write/governance/administration operations are **withheld** — not served, no
local switch or credential can enable them. This keeps Action possession from
being mistaken for Resource authorization and keeps the inventory's non-atomic
preconditions from being mistaken for authoritative revision or plan/apply
binding.

## Runtime configuration

Required in normal deployments:

| Variable | Purpose |
| --- | --- |
| `FORGEJO_OPS_WIDGET_TRANSPORT_MODE` | Token-bound direction: exactly `WORLD_A` or `WORLD_B`; no detection or fallback. |
| `FORGEJO_OPS_WIDGET_CALLBACK_TOKEN` | Authenticates Platform callbacks. |

World A additionally requires `FORGEJO_OPS_WIDGET_PLATFORM_URL` (normally
`https://platform.xtrape.com`) and the Widget Token in
`FORGEJO_OPS_WIDGET_REGISTRATION_TOKEN`. World B forbids both of those values
and requires a fixed callback port plus the operator-vouched external callback
address. It is strictly listen-only; the Widget never dials or probes Platform.

Read-only Forgejo target (#7), both required together or both absent:

| Variable | Purpose |
| --- | --- |
| `FORGEJO_OPS_FORGEJO_URL` | **First-boot seed only** (#32): Forgejo origin imported once into the target store when it is empty; afterwards the store is the authority and this variable is ignored. |
| `FORGEJO_OPS_COLLABORATION_TOKEN` | **First-boot seed only** (#32): Forgejo API token imported with the URL. Never returned in output, logs, or audit detail. |
| `FORGEJO_OPS_BOUNDED_CHECKPOINTS` | Optional comma-separated allowlist (e.g. `repository.get,pull-request.context.get,branch.create,pull-request.change.commit,pull-request.create,pull-request.merge.guarded`) narrowing/opting-in the served set; a write is served only when named; present-but-empty fails closed. |
| `FORGEJO_OPS_EXECUTION_PROFILE_DIGEST` | Optional: pin which admitted execution profile the Checkpoint factory selects. |

A URL without a token (or a token without a URL) fails closed. With neither set
the Widget starts governed but unconfigured, and the target is set through the
`setTarget` Action (see *Target configuration* below). **Single-target invariant (#19):** the
Service ID is the `service` segment of every governed Resource, and the Resource
identity does not encode the Forgejo origin — so one Service ID names exactly one
origin. Addressing a second Forgejo origin requires a distinct Service ID, never
the same one; there is deliberately no separate target-id knob. Other optional
variables include Service ID, configuration directory and a provisioned Instance
ID (World A Instance ID persisted under the configuration directory with mode
0600). The
**administration credential is rejected** and `FORGEJO_OPS_ENABLE_DESTRUCTIVE=true`
is refused — the only mutation paths are the governed #10 + #16 writes above
(all on the collaboration credential); there is no hidden one, and the only
merge is the guarded one.

World A or World B is an operator choice bound during Widget Token/Instance
provisioning. Action implementations are transport-neutral. Runtime config
must agree with the token direction and fails closed on mixed material; it does
not silently change direction after a connection failure.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For hardened deployment, immutable-image requirements, readiness, rollback,
credential rotation, and the current Checkpoint-registration dependency, see
[`OPERATIONS.md`](OPERATIONS.md). The reference Compose profile is under
`deploy/`.

## Status

Serves the **bounded governed reference profile**: the read-only Checkpoints
(#7's repository / issue / pull-request metadata plus #16's
`pull-request.context.get` decision snapshot) by default, plus the #10
collaboration writes and #16's Phase B development-loop writes (working branch,
bounded corrective commit, Issue evidence, and the guarded merge) — each write
served ONLY when `FORGEJO_OPS_BOUNDED_CHECKPOINTS` names it explicitly; an
absent allowlist keeps the read-only surface, so swapping this build into an
existing deployment changes no authority. Each is an exact immutable Checkpoint
published through the Connector factory and authorized/invoked by the Platform
against a normalized Forgejo Resource. This is the non-host, lower-side-effect
reference domain that, alongside Linux Ops, proves cross-domain protocol
neutrality (docs#262 H1). With no target configured the Widget is still
governed — the `target.*` Checkpoints are served — and the domain reads fail
closed until `setTarget` gives it one.

## Target configuration (#32)

Owner ruling 2026-09-05: a Service's business configuration is set through its
entry Action; env carries only what needs a restart to take effect. The Forgejo
target needs no restart, so it is runtime state in the Widget's conf directory
(`forgejo-target.json`, mode 0600) and is managed by three governed Actions on
the Service itself (their Resource is the Service, not a repository):

| Action | Checkpoint | Side effect | What it does |
| --- | --- | --- | --- |
| `listOrganizations` | `organization.list@1.0.0` | READ_ONLY (default) | LIST-FIRST entry (owner 2026-09-06): every organization the credential can see (`/user/orgs`, needs `read:organization`), visibility marked per row (public green / private orange) — ONE list, the same for Panel and Exposure; each row leads to that organization's repositories |
| `listRepositories` | `repository.list@1.0.0` | READ_ONLY (default) | every repository the credential can see (`/user/repos`, needs `read:user`), visibility marked, all or chosen `owners`; each row leads to `getRepository` with owner/repo carried from the row. Listing metadata is INTERNAL under the owner's classification ruling (2026-09-06); `getRepository` therefore runs behind no public gate |
| `manageTarget` | `target.manage@1.0.0` | READ_ONLY (default) | the ENTRY (Widget Design Conventions §2): the target as a list of one — URL, when it was configured, by which route, credential present/absent — with **Test** and **Edit** as row operations (Configure when nothing is set). `testTarget` / `setTarget` are its hidden `_target` sub-operations |
| `testTarget` | `target.test@1.0.0` | READ_ONLY (default) | probes the current target with its credential: Forgejo version + the identity the token resolves to |
| `setTarget` | `target.set@1.0.0` | MUTATING / HIGH — served only when `FORGEJO_OPS_BOUNDED_CHECKPOINTS` names it | replaces URL and/or credential; `collaborationToken` is a protected field (`writeOnly` + `x-xtrape-sensitive`; blank on edit keeps the current one); the new pair is **probed before it is stored** |

What stays in env (restart-bound): transport mode, Platform URL, Widget Token,
callback host/port/token/address, conf directory, Service ID, execution profile
digest, and `FORGEJO_OPS_BOUNDED_CHECKPOINTS` (it changes the published
Checkpoint set, which needs re-registration).

The only governed merge is `pull-request.merge.guarded`, which fails closed on
head/mergeability/qualifying-review/blocking-review/required-check state; the
unguarded `mergePullRequest` stays dormant inventory. The broader Forgejo
control-plane roadmap (#1 — repository lifecycle, branch-protection
administration, teams, webhooks, releases, bulk operations) is out of this Phase
B slice, and the administration credential and destructive execution stay
refused.
