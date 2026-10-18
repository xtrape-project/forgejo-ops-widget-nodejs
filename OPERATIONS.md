# Production operations

## Deployment invariant

Deploy an immutable OCI coordinate (`repository@sha256:digest`), not a mutable
tag. The release workflow builds one image and requires digest parity between
the Forgejo registry and GHCR. Preserve its evidence line with the release
record.

The reference Compose profile runs as a non-root user with no Linux
capabilities, a read-only root filesystem, bounded resources, and a persistent
configuration volume for the World A Instance ID.

## Provisioning

1. Choose World A or World B when creating the Widget Token/Instance.
2. The Forgejo target is runtime state (#32): configure it after start through
   the governed `setTarget` Action (name `target.set` in
   `FORGEJO_OPS_BOUNDED_CHECKPOINTS` to serve it), or seed it ONCE on first
   boot with `FORGEJO_OPS_FORGEJO_URL` + `FORGEJO_OPS_COLLABORATION_TOKEN`
   (both or neither; ignored once the store holds a target). The
   `administration` credential and destructive execution stay rejected.
   Without a target the Widget is governed but its domain reads fail closed.
3. Copy `deploy/widget.env.example` to `deploy/widget.env`, populate it through
   the production secret store, and restrict the file to the deployment
   operator. `widget.env` is ignored by Git.
4. Set `FORGEJO_OPS_WIDGET_REPOSITORY` to the registry/repository and
   `FORGEJO_OPS_WIDGET_DIGEST` to exactly the 64 lowercase hex characters after
   `sha256:`. Compose constructs `repository@sha256:digest`; a mutable tag-only
   coordinate cannot satisfy the deployment file.
5. In World B, remove Platform URL and registration token, keep the fixed
   callback port/token, and set the callback address to the operator-vouched
   address recorded in Platform. There is no direction fallback.

## Readiness gate

Before admitting traffic — **governed profile** (a Forgejo target is
provisioned):

- `/health` returns HTTP 200 through the deployment network;
- the Platform shows the expected Service/Instance with the `forgejo.inspect`
  capability;
- the authenticated external Action catalog is exactly the bounded read-only
  set — `getRepository`, `getIssue`, `getPullRequest` (or the
  `FORGEJO_OPS_BOUNDED_CHECKPOINTS` subset), each bound to its Checkpoint;
- any OTHER Forgejo domain Action (`getFile`, `commentIssue`, every
  write/administration entry) is rejected as unknown without contacting
  Forgejo;
- in World A the Checkpoints and extractor artifacts published at
  registration; in World B the operator has admitted the extractor artifacts
  printed by `scripts/print-extractor-artifacts.mjs` **run bound to this
  deployment's exact `FORGEJO_OPS_WIDGET_SERVICE_ID`** (see the provisioning
  step below) and provisioned the descriptor's Checkpoint definitions (built
  against the pinned `FORGEJO_OPS_EXECUTION_PROFILE_DIGEST`);
- only the `collaboration` credential is present; the administration
  credential is refused at startup;
- no token or Forgejo response body appears in application logs.

**Inert profile** (no Forgejo target): the Platform shows only the non-domain
`forgejo.bootstrap` capability, the Action catalog is exactly `[]`, and no
Forgejo credential is present.

For World A, a fatal long-poll/authentication/ownership failure terminates the
process so the supervisor cannot keep a disconnected instance falsely healthy.

## Upgrade and rollback

1. Compare the candidate catalog and Checkpoint coordinates with the deployed
   release. Treat removal or semantic weakening as a breaking change.
2. Run the full unit suite and the Forgejo 15 integration script against a
   disposable instance.
3. Deploy the immutable candidate digest and repeat the readiness gate.
4. Roll back by restoring the previous immutable digest. Keep `/app/conf` so
   World A retains its stable Instance ID.

Do not roll back by moving a release tag. Registry tags are discovery aids;
the digest is the deployment identity.

## Credential rotation

Rotate the Forgejo `collaboration` token with the governed `setTarget` Action
(same URL, new token — no restart; the pair is probed before it is stored) —
the seed variable is not re-read after first boot. The Widget keeps the token
in its 0600 conf file and in memory only, and never returns it in output,
logs, or audit detail. Rotating the Widget registration/callback material must follow the
Platform Instance provisioning workflow for the configured direction; never
switch World A/World B as a connection-recovery heuristic.

## Checkpoint provisioning by direction

`@xtrape/connector@0.8.5` carries the governed slice in both directions, with
different mechanics (the Connector refuses the wrong combination at startup):

- **World A**: the Checkpoint FACTORY runs on the instance credential after
  registration — it selects the single admitted execution profile (or the one
  pinned by `FORGEJO_OPS_EXECUTION_PROFILE_DIGEST`) and publishes the
  resource-extractor artifacts before returning the immutable definitions.
- **World B (listen-only)**: there is no registration and no factory. The
  authenticated descriptor carries the Checkpoint definitions and schema
  records as a plain, operator-provisioned atomic snapshot, built against the
  REQUIRED pinned `FORGEJO_OPS_EXECUTION_PROFILE_DIGEST`. The extractor
  artifacts the definitions reference by digest are the operator's
  provisioning step. The artifact digest is a function of the Service ID, so
  the command MUST bind this deployment's EXACT `FORGEJO_OPS_WIDGET_SERVICE_ID`
  — run it with that deployment's environment, or pass the id explicitly:

  ```sh
  # bind the exact deployed Service ID (one of):
  FORGEJO_OPS_WIDGET_SERVICE_ID="$DEPLOYED_SERVICE_ID" node scripts/print-extractor-artifacts.mjs
  node scripts/print-extractor-artifacts.mjs "$DEPLOYED_SERVICE_ID"
  ```

  The script **fails closed** when neither an argument nor
  `FORGEJO_OPS_WIDGET_SERVICE_ID` is set: it never falls back to the package
  default, so a bare-shell run can no longer silently provision the wrong
  Service ID (review #3092). It prints the exact digest, media type and
  canonical bytes to admit Platform-side, and echoes the resolved `serviceId`
  and its `serviceIdSource` so the operator can confirm the binding. Growth is
  a re-provision, never a runtime publish.

Mutation admission remains out of scope for 0.8.7: it additionally requires
repository rename, guarded merge, destructive/access plan/apply, authoritative
reason/audit binding, and atomic state work. The Widget must not bypass the
Connector with a raw Platform request.
