import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TargetStore } from '../src/target-store.js';
import { buildTargetCeActions, probeTarget } from '../src/target-actions.js';
import { checkpointRefFor, isCheckpointExposed, parseBoundedCheckpoints } from '../src/checkpoints.js';

/** A fake Forgejo: /api/v1/version answers; /api/v1/user checks the token. */
function fakeForgejo(goodToken: string, opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url); calls.push(u);
    if (opts.down) throw new Error('connect ECONNREFUSED');
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (u.endsWith('/api/v1/version')) return new Response(JSON.stringify({ version: '15.0.2' }), { status: 200 });
    if (u.endsWith('/api/v1/user')) {
      if (auth === `token ${goodToken}`) return new Response(JSON.stringify({ login: 'm1ops' }), { status: 200 });
      if (auth === 'token scoped') return new Response('{}', { status: 403 }); // valid token without read:user (the m1 fixture's shape)
      return new Response('{}', { status: 401 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function actionsFor(store: TargetStore, fetchImpl: typeof fetch, bounded: string | undefined = undefined) {
  const b = parseBoundedCheckpoints(bounded);
  return buildTargetCeActions({ store, refFor: (n) => checkpointRefFor('svc', n), exposed: (id) => isCheckpointExposed(id, b), fetchImpl });
}
const dir = () => mkdtempSync(join(tmpdir(), 'forgejo-ops-target-'));

describe('target actions (#32)', () => {
  it('probeTarget: reachable + accepted credential; wrong credential is named; a down host is unreachable', async () => {
    expect(await probeTarget('https://f.example', 'good', fakeForgejo('good').fetchImpl)).toEqual({ reachable: true, credentialAccepted: true, version: '15.0.2', login: 'm1ops' });
    // A read:repository-only token answers 403 on /user: accepted, no login (the m1 fixture's shape).
    expect(await probeTarget('https://f.example', 'scoped', fakeForgejo('good').fetchImpl)).toEqual({ reachable: true, credentialAccepted: true, version: '15.0.2' });
    expect(await probeTarget('https://f.example', 'bad', fakeForgejo('good').fetchImpl)).toMatchObject({ reachable: true, credentialAccepted: false, error: expect.stringContaining('401') });
    expect(await probeTarget('https://f.example', 'good', fakeForgejo('good', { down: true }).fetchImpl)).toMatchObject({ reachable: false });
  });

  it('exposure: the two reads are defaults, setTarget only when named (a write like every other write)', () => {
    const store = new TargetStore(dir(), 'svc');
    expect(actionsFor(store, fakeForgejo('x').fetchImpl).map((a) => a.name).sort()).toEqual(['manageTarget', 'testTarget']);
    expect(actionsFor(store, fakeForgejo('x').fetchImpl, 'target.set').map((a) => a.name)).toEqual(['setTarget']);
    const set = actionsFor(store, fakeForgejo('x').fetchImpl, 'target.set')[0]!;
    expect(set.checkpoint).toEqual({ serviceId: 'svc', checkpointId: 'target.set', checkpointVersion: '1.0.0' });
    const props = (set.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props['collaborationToken']).toMatchObject({ writeOnly: true, 'x-xtrape-sensitive': true });
  });

  it('manageTarget is the ENTRY: a list of one row with Test / Edit as row operations, Configure when nothing is set; the credential only as PRESENT', async () => {
    const store = new TargetStore(dir(), 'svc');
    const [manage, test] = actionsFor(store, fakeForgejo('good').fetchImpl);
    expect(manage!.name).toBe('manageTarget');
    expect(manage!.category).toBe('target');
    expect(test!.category).toBe('_target'); // sub-operation: executable, hidden from the operator catalog
    const empty = await manage!.execute({}, {} as never) as { data: { configured: boolean; list: Record<string, unknown> } };
    expect(empty.data.configured).toBe(false);
    expect(empty.data.list).toMatchObject({ data: [], pageActions: [{ action: 'setTarget', label: 'Configure' }] });
    await expect(test!.execute({}, {} as never)).rejects.toThrow(/no Forgejo target is configured/);
    store.set({ baseUrl: 'https://f.example', collaborationToken: 'good' });
    const shown = await manage!.execute({}, {} as never) as { data: { configured: boolean; list: { data: Record<string, unknown>[]; rowActions: Array<{ action: string }>; pageActions: unknown[] } } };
    expect(shown.data.configured).toBe(true);
    expect(shown.data.list.data).toHaveLength(1);
    expect(shown.data.list.data[0]).toMatchObject({ baseUrl: 'https://f.example', hasCollaborationToken: true, source: 'action' });
    expect(shown.data.list.rowActions.map((a) => a.action)).toEqual(['testTarget', 'setTarget']);
    expect(shown.data.list.pageActions).toEqual([]);
    expect(JSON.stringify(shown)).not.toContain('good');
    expect(await test!.execute({}, {} as never)).toMatchObject({ success: true, data: { baseUrl: 'https://f.example', reachable: true, credentialAccepted: true, login: 'm1ops' } });
    // A rejected credential is a SUCCESSFUL test reporting a negative, not a failed command.
    store.set({ baseUrl: 'https://f.example', collaborationToken: 'bad' });
    expect(await test!.execute({}, {} as never)).toMatchObject({ success: true, data: { reachable: true, credentialAccepted: false } });
  });

  it('setTarget probes BEFORE storing: a pair that does not answer replaces nothing; a good pair is stored; blank credential keeps the current one', async () => {
    const store = new TargetStore(dir(), 'svc');
    const good = fakeForgejo('good');
    const set = actionsFor(store, good.fetchImpl, 'target.set')[0]!;
    await expect(set.execute({ baseUrl: 'not a url', collaborationToken: 'good' }, {} as never)).rejects.toThrow(/http\(s\) URL/);
    await expect(set.execute({ baseUrl: 'https://f.example' }, {} as never)).rejects.toThrow(/required the first time/);
    await expect(set.execute({ baseUrl: 'https://f.example', collaborationToken: 'bad' }, {} as never)).rejects.toThrow(/NOT stored/);
    expect(store.current()).toBeNull();
    const ok = await set.execute({ baseUrl: 'https://f.example/', collaborationToken: 'good' }, {} as never) as { data: { target: { baseUrl: string }; probe: { login?: string } } };
    expect(ok.data.target.baseUrl).toBe('https://f.example');
    expect(ok.data.probe.login).toBe('m1ops');
    expect(JSON.stringify(ok)).not.toContain('"good"');
    // Edit the URL only: the stored credential is reused for the probe and kept.
    const moved = fakeForgejo('good');
    const set2 = actionsFor(store, moved.fetchImpl, 'target.set')[0]!;
    await set2.execute({ baseUrl: 'https://g.example', collaborationToken: '' }, {} as never);
    expect(store.asForgejoTarget()).toEqual({ id: 'svc', baseUrl: 'https://g.example', credentials: { collaboration: 'good' } });
  });
});
