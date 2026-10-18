import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateInstanceId } from '../src/instance.js';

const dirs: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgejo-ops-widget-id-'));
  dirs.push(directory);
  return directory;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('stable instance identity', () => {
  it('creates and reuses a 0600 identity file', () => {
    const directory = temporaryDirectory();
    const first = loadOrCreateInstanceId(directory, {});
    expect(first).toMatch(/^forgejo-ops-widget-[0-9a-f]{8}$/);
    expect(loadOrCreateInstanceId(directory, {})).toBe(first);
    expect(statSync(join(directory, 'instance-id')).mode & 0o777).toBe(0o600);
  });

  it('tightens a pre-existing identity file', () => {
    const directory = temporaryDirectory(); const file = join(directory, 'instance-id');
    writeFileSync(file, 'fixed-worker\n'); chmodSync(file, 0o644);
    expect(loadOrCreateInstanceId(directory, {})).toBe('fixed-worker');
    expect(readFileSync(file, 'utf8').trim()).toBe('fixed-worker');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('honors an operator-provisioned override without touching disk', () => {
    const directory = temporaryDirectory();
    expect(loadOrCreateInstanceId(directory, { FORGEJO_OPS_WIDGET_INSTANCE_ID: 'provisioned-worker' })).toBe('provisioned-worker');
    expect(() => readFileSync(join(directory, 'instance-id'))).toThrow();
  });
});
