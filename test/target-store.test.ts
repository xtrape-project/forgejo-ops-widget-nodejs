import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TargetStore } from '../src/target-store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'forgejo-ops-target-'));

describe('TargetStore (#32: the target is runtime state, env is a first-boot seed)', () => {
  it('starts empty, seeds ONCE from env, then ignores env', () => {
    const d = dir(); const s = new TargetStore(d, 'svc');
    expect(s.current()).toBeNull();
    expect(s.seedFromEnv(undefined, undefined)).toBe('none');
    expect(s.seedFromEnv('https://a.example/', 'tok-a')).toBe('seeded');
    expect(s.facts()).toMatchObject({ baseUrl: 'https://a.example', source: 'env-seed', hasCollaborationToken: true });
    // A later boot with a different env pair changes nothing: the store is the authority.
    expect(new TargetStore(d, 'svc').seedFromEnv('https://b.example', 'tok-b')).toBe('kept');
    expect(new TargetStore(d, 'svc').facts()?.baseUrl).toBe('https://a.example');
  });

  it('set replaces the target; a blank credential keeps the current one; the file is 0600 and never returns the token in facts', () => {
    const d = dir(); const s = new TargetStore(d, 'svc');
    expect(() => s.set({ baseUrl: 'https://a.example' })).toThrow(/collaboration token is required/);
    s.set({ baseUrl: 'https://a.example', collaborationToken: 'tok-a' });
    const facts = s.set({ baseUrl: 'https://b.example' });
    expect(facts).toMatchObject({ baseUrl: 'https://b.example', source: 'action', hasCollaborationToken: true });
    expect(JSON.stringify(facts)).not.toContain('tok-a');
    expect(s.asForgejoTarget()).toEqual({ id: 'svc', baseUrl: 'https://b.example', credentials: { collaboration: 'tok-a' } });
    const mode = statSync(join(d, 'forgejo-target.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(join(d, 'forgejo-target.json'), 'utf8')).collaborationToken).toBe('tok-a');
  });
});
