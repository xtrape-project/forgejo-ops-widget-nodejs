import { describe, expect, it, vi } from 'vitest';
import { ForgejoClientProvider } from '../src/credentials.js';

describe('ForgejoClientProvider', () => {
  it('never falls back from collaboration to administration', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const authorization = new Request(request).headers.get('authorization');
      expect(authorization).toBe('token collaboration-secret');
      expect(authorization).not.toContain('administration-secret');
      return new Response(JSON.stringify({ id: 1, name: 'repo', full_name: 'owner/repo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new ForgejoClientProvider(
      {
        id: 'default',
        baseUrl: 'https://forgejo.example.test',
        credentials: { collaboration: 'collaboration-secret', administration: 'administration-secret' },
      },
      fetchImpl,
    );

    await provider.forProfile('collaboration').GET('/repos/{owner}/{repo}', {
      params: { path: { owner: 'owner', repo: 'repo' } },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed when administration is absent', () => {
    const provider = new ForgejoClientProvider({
      id: 'default',
      baseUrl: 'https://forgejo.example.test',
      credentials: { collaboration: 'collaboration-secret' },
    });
    expect(provider.hasProfile('administration')).toBe(false);
    expect(() => provider.forProfile('administration')).toThrow(/not configured/);
  });
});
