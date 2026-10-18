import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    FORGEJO_OPS_WIDGET_TRANSPORT_MODE: 'WORLD_A',
    FORGEJO_OPS_WIDGET_PLATFORM_URL: 'https://platform.xtrape.com',
    FORGEJO_OPS_WIDGET_REGISTRATION_TOKEN: 'registration-value',
    FORGEJO_OPS_WIDGET_CALLBACK_TOKEN: 'callback-value',
    FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS: 'https://forgejo-ops.example.test',
  };
}

describe('loadConfig', () => {
  it('loads a minimal production-safe configuration', () => {
    const config = loadConfig(validEnv());
    expect(config.platformUrl).toBe('https://platform.xtrape.com');
    expect(config.serviceId).toBe('forgejo-ops-widget-nodejs');
  });

  it('keeps administration credential and destructive execution gated (0.8.7 non-goals #7)', () => {
    const withAdmin = validEnv();
    withAdmin.FORGEJO_OPS_ADMINISTRATION_TOKEN = 'administration-value';
    expect(() => loadConfig(withAdmin)).toThrow(/administration credential is not accepted/);
    const withDestructive = validEnv();
    withDestructive.FORGEJO_OPS_ENABLE_DESTRUCTIVE = 'true';
    expect(() => loadConfig(withDestructive)).toThrow(/destructive execution is a 0\.8\.7 non-goal/);
  });

  it('accepts a read-only Forgejo target (URL + collaboration token) for #7', () => {
    const env = validEnv();
    env.FORGEJO_OPS_FORGEJO_URL = 'https://forgejo.example.test/';
    env.FORGEJO_OPS_COLLABORATION_TOKEN = 'collaboration-value';
    const config = loadConfig(env);
    expect(config.forgejoBaseUrl).toBe('https://forgejo.example.test'); // trailing slash normalized
    expect(config.collaborationToken).toBe('collaboration-value');
  });

  it('ignores FORGEJO_OPS_TARGET_ID — single-target invariant, no separate target-id knob (#19)', () => {
    const env = validEnv();
    env.FORGEJO_OPS_FORGEJO_URL = 'https://forgejo.example.test';
    env.FORGEJO_OPS_COLLABORATION_TOKEN = 'collaboration-value';
    env.FORGEJO_OPS_TARGET_ID = 'some-other-id';
    const config = loadConfig(env);
    // The Service ID alone is the governed Resource identity; a target-id knob
    // that does not enter that identity would only pretend at multi-target.
    expect((config as unknown as Record<string, unknown>).targetId).toBeUndefined();
    expect(config.serviceId).toBe('forgejo-ops-widget-nodejs');
  });

  it('rejects a partial read-only target (URL without token, or token without URL)', () => {
    const urlOnly = validEnv();
    urlOnly.FORGEJO_OPS_FORGEJO_URL = 'https://forgejo.example.test';
    expect(() => loadConfig(urlOnly)).toThrow(/needs BOTH/);
    const tokenOnly = validEnv();
    tokenOnly.FORGEJO_OPS_COLLABORATION_TOKEN = 'collaboration-value';
    expect(() => loadConfig(tokenOnly)).toThrow(/needs BOTH/);
  });

  it('fails closed without authenticated callbacks', () => {
    const env = validEnv();
    delete env.FORGEJO_OPS_WIDGET_CALLBACK_TOKEN;
    expect(() => loadConfig(env)).toThrow(/CALLBACK_TOKEN is required/);
  });

  it('allows insecure callback only when explicitly loopback-only', () => {
    const env = validEnv();
    delete env.FORGEJO_OPS_WIDGET_CALLBACK_TOKEN;
    env.FORGEJO_OPS_WIDGET_ALLOW_INSECURE_CALLBACK = 'true';
    env.FORGEJO_OPS_WIDGET_CALLBACK_HOST = '127.0.0.1';
    delete env.FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS;
    expect(loadConfig(env).callbackToken).toBeUndefined();
    env.FORGEJO_OPS_WIDGET_CALLBACK_HOST = '0.0.0.0';
    expect(() => loadConfig(env)).toThrow(/CALLBACK_TOKEN is required/);
  });

  it('rejects Platform URLs that contain embedded credentials', () => {
    const env = validEnv();
    env.FORGEJO_OPS_WIDGET_PLATFORM_URL = 'https://user:password@platform.xtrape.com';
    expect(() => loadConfig(env)).toThrow(/without credentials/);
  });

  it('requires an explicit token-bound transport mode', () => {
    const env = validEnv();
    delete env.FORGEJO_OPS_WIDGET_TRANSPORT_MODE;
    expect(() => loadConfig(env)).toThrow(/must be WORLD_A or WORLD_B/);
  });

  it('loads a pure World B listen-only configuration', () => {
    const env = validEnv();
    env.FORGEJO_OPS_WIDGET_TRANSPORT_MODE = 'WORLD_B';
    delete env.FORGEJO_OPS_WIDGET_PLATFORM_URL;
    delete env.FORGEJO_OPS_WIDGET_REGISTRATION_TOKEN;
    env.FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS = 'https://forgejo-ops.example.test';
    env.FORGEJO_OPS_WIDGET_CALLBACK_PORT = '8080';
    env.FORGEJO_OPS_EXECUTION_PROFILE_DIGEST = `sha256:${'a'.repeat(64)}`; // governed always (#32): the pin is unconditional in World B
    const config = loadConfig(env);
    expect(config.transportMode).toBe('WORLD_B');
    expect(config.platformUrl).toBeUndefined();
  });

  it('rejects mixed World A and World B provisioning material', () => {
    const env = validEnv();
    env.FORGEJO_OPS_WIDGET_TRANSPORT_MODE = 'WORLD_B';
    env.FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS = 'https://forgejo-ops.example.test';
    expect(() => loadConfig(env)).toThrow(/must not receive Platform URL/);
  });

  it('WORLD_B requires the pinned execution-profile digest — with or without a target (#8 review 2694; unconditional since #32)', () => {
    const worldB = (): NodeJS.ProcessEnv => {
      const env = validEnv();
      env.FORGEJO_OPS_WIDGET_TRANSPORT_MODE = 'WORLD_B';
      delete env.FORGEJO_OPS_WIDGET_PLATFORM_URL;
      delete env.FORGEJO_OPS_WIDGET_REGISTRATION_TOKEN;
      env.FORGEJO_OPS_WIDGET_CALLBACK_ADDRESS = 'https://forgejo-ops.example.test';
      env.FORGEJO_OPS_WIDGET_CALLBACK_PORT = '8080';
      env.FORGEJO_OPS_FORGEJO_URL = 'https://forgejo.example.test';
      env.FORGEJO_OPS_COLLABORATION_TOKEN = 'collaboration-value';
      return env;
    };
    // A listen-only Widget has no registration and no Checkpoint factory, so
    // nothing can discover the admitted profile — the operator must pin it.
    expect(() => loadConfig(worldB())).toThrow(/FORGEJO_OPS_EXECUTION_PROFILE_DIGEST/);
    const noTarget = worldB(); delete noTarget.FORGEJO_OPS_FORGEJO_URL; delete noTarget.FORGEJO_OPS_COLLABORATION_TOKEN;
    expect(() => loadConfig(noTarget)).toThrow(/FORGEJO_OPS_EXECUTION_PROFILE_DIGEST/);
    const pinned = worldB();
    pinned.FORGEJO_OPS_EXECUTION_PROFILE_DIGEST = `sha256:${'a'.repeat(64)}`;
    const config = loadConfig(pinned);
    expect(config.executionProfileDigest).toBe(`sha256:${'a'.repeat(64)}`);
    // A malformed digest is refused outright.
    const bad = worldB();
    bad.FORGEJO_OPS_EXECUTION_PROFILE_DIGEST = 'not-a-digest';
    expect(() => loadConfig(bad)).toThrow(/sha256:<64 lowercase hex>/);
  });
});
