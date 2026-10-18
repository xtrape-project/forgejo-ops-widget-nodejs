import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startWidget } from '../src/index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return address.port;
}

describe('World B connector integration', () => {
  it('authenticates callbacks; without a target it serves the target.* reads and the default domain reads, which fail closed until a target is set (#32)', async () => {
    const widgetPort = await (async () => {
      const reservation = createServer(); const port = await listen(reservation);
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      servers.splice(servers.indexOf(reservation), 1);
      return port;
    })();
    const handle = await startWidget({
      transportMode: 'WORLD_B', callbackToken: 'callback-token', callbackHost: '127.0.0.1', callbackPort: widgetPort,
      callbackAddress: `http://127.0.0.1:${widgetPort}`, serviceId: 'forgejo-ops-widget-nodejs', confDir: mkdtempSync(join(tmpdir(), 'forgejo-ops-conf-')),
      executionProfileDigest: `sha256:${'a'.repeat(64)}`,
    });
    try {
      const unauthenticated = await fetch(`${handle.address}/actions`);
      expect(unauthenticated.status).toBe(401);

      const catalog = await fetch(`${handle.address}/actions`, {
        headers: { 'x-xtrape-service-callback-token': 'callback-token' },
      });
      expect(catalog.status).toBe(200);
      const actions = await catalog.json() as Array<{ name: string }>;
      expect(actions.map((a) => a.name).sort()).toEqual(['getIssue', 'getPullRequest', 'getPullRequestContext', 'getRepository', 'listIssues', 'listOrganizations', 'listPullRequests', 'listRepositories', 'manageTarget', 'testTarget']);

      const execution = await fetch(`${handle.address}/actions/getRepository/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xtrape-service-callback-token': 'callback-token' },
        body: JSON.stringify({ owner: 'xtrape', repo: 'repo' }),
      });
      // Served, but no target yet: fails closed naming the precondition (the
      // Connector maps a thrown execute error to its error status), not a 404.
      expect(execution.status).toBe(500);
      const text = await execution.text();
      expect(text).toContain('no Forgejo target is configured');
    } finally {
      await handle.close();
    }
  });
});
