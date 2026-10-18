import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release and deployment invariants', () => {
  it('accepts only strict OCI-compatible SemVer release versions', () => {
    for (const version of ['0.8.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0']) {
      expect(() => execFileSync('bash', ['scripts/validate-release-version.sh', version])).not.toThrow();
    }
    for (const version of ['01.8.0', '0.08.0', '0.8.00', '0.8.0-', '0.8.0-alpha..1', '0.8.0-01', '0.8.0+build']) {
      expect(() => execFileSync('bash', ['scripts/validate-release-version.sh', version], { stdio: 'ignore' })).toThrow();
    }
  });

  it('constructs the deployment image from a repository and mandatory digest', () => {
    const compose = readFileSync('deploy/compose.yaml', 'utf8');
    expect(compose).toContain('${FORGEJO_OPS_WIDGET_REPOSITORY:?set the OCI repository}@sha256:${FORGEJO_OPS_WIDGET_DIGEST:?set the 64-hex manifest digest}');
    expect(compose).not.toContain('FORGEJO_OPS_WIDGET_IMAGE');
  });
});
