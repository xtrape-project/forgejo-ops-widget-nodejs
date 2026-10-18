import { WidgetActionError } from './errors.js';

/** Local policy is narrowing-only: this function can suppress an Action, never authorize one. */
export function locallyAvailable(): false {
  // The Connector (0.8.4 as of this build) still cannot publish canonical
  // Checkpoints or Resource extractors. There is deliberately no
  // credential/configuration argument that can enable even a read before
  // that authority surface exists.
  return false;
}

export function assertExpectedRevision(actual: string | undefined, expected: string): void {
  if (!actual || actual !== expected) {
    throw new WidgetActionError('PRECONDITION_FAILED', 'expected revision does not match the current Forgejo revision');
  }
}

export function assertWritableBranch(protectedBranch: boolean | undefined): void {
  if (protectedBranch === true) {
    throw new WidgetActionError('PRECONDITION_FAILED', 'protected branch mutation is denied by Widget-local safety policy');
  }
}
