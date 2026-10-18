# AGENTS.md

## Repository role

This is the single Forgejo Widget. It owns all Forgejo Capabilities, Actions,
and Checkpoints, from inspection and collaboration through governance and
administration.

## Red lines

- Do not recreate `forgejo-api-widget-nodejs`; risk tiers are not separate
  Widget products.
- Do not implement MCP transport or tool projection here.
- Do not implement a raw Forgejo request, arbitrary endpoint, or shell Action.
- Do not make authorization, approval, or authoritative audit decisions that
  belong to the Platform.
- Local policy may only narrow or deny.
- Ordinary Actions must never receive an administration credential.

## Dependency boundary

- Typed Forgejo HTTP mechanics come from `@xtrape/forgejo-api`.
- Platform connectivity comes from `@xtrape/connector` and the widget contract.
- Every external operation is represented by a schema-bound, versioned Action
  and Checkpoint with explicit side effect, risk, credential profile, and local
  preconditions.

## Required security tests

- one unique owner per Action/Checkpoint;
- credential-profile isolation;
- protected-branch and expected-revision checks;
- destructive operations fail closed without explicit enablement;
- Platform denial cannot be overridden locally;
- secrets and Forgejo credentials never enter output, logs, or audit details.
