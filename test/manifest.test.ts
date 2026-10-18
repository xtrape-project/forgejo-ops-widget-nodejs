import { describe, expect, it } from 'vitest';
import { ServiceManifestSchema } from '@xtrape/contracts';
import { buildManifest } from '../src/manifest.js';

describe('manifest', () => {
  it('publishes only the non-domain bootstrap capability while inert', () => {
    const manifest = buildManifest();
    expect(ServiceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.service.id).toBe('forgejo-ops-widget-nodejs');
    expect(manifest.capabilities).toEqual(['forgejo.bootstrap']);
  });

  it('states the truth for a read-only deployment: forgejo.inspect, not bootstrap (#8 review 2694)', () => {
    const manifest = buildManifest('forgejo-ops-widget-nodejs', { servedCapabilities: ['forgejo.inspect'] });
    expect(ServiceManifestSchema.safeParse(manifest).success).toBe(true);
    // The manifest names what THIS deployment runs, not what the catalog owns.
    expect(manifest.capabilities).toEqual(['forgejo.inspect']);
    expect(manifest.service.description).toContain('read-only');
    expect(manifest.service.description).not.toContain('withheld');
  });

  it('states the truth when the allowlist exposes writes: forgejo.collaborate, no read-only claim (#18 review 3075)', () => {
    const manifest = buildManifest('forgejo-ops-widget-nodejs', { servedCapabilities: ['forgejo.inspect', 'forgejo.collaborate'] });
    expect(ServiceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.capabilities).toEqual(['forgejo.collaborate', 'forgejo.inspect']); // sorted
    // A deployment serving the #10/#16 writes must not describe itself as
    // read-only or claim writes are withheld.
    expect(manifest.service.description).not.toMatch(/read-only|withheld/);
    expect(manifest.service.description).toContain('guarded merge');
  });

  it('advertises forgejo.content when a content Checkpoint (branch / commit) is served (#18 review 3076)', () => {
    const manifest = buildManifest('forgejo-ops-widget-nodejs', { servedCapabilities: ['forgejo.inspect', 'forgejo.content'] });
    expect(ServiceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.capabilities).toEqual(['forgejo.content', 'forgejo.inspect']); // sorted
    expect(manifest.service.description).not.toMatch(/read-only|withheld/);
  });

  it('never advertises a domain capability without a served capability', () => {
    expect(buildManifest('custom-service').capabilities).toEqual(['forgejo.bootstrap']);
    expect(buildManifest('custom-service', {}).capabilities).toEqual(['forgejo.bootstrap']);
    expect(buildManifest('custom-service', { servedCapabilities: [] }).capabilities).toEqual(['forgejo.bootstrap']);
  });
});
