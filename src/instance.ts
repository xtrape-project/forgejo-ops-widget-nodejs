import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stable World A Worker identity across restarts. The identifier is public, but the file is tightened to 0600. */
export function loadOrCreateInstanceId(confDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FORGEJO_OPS_WIDGET_INSTANCE_ID?.trim();
  if (override) return override;
  const file = join(confDir, 'instance-id');
  let existing = '';
  let exists = false;
  try {
    existing = readFileSync(file, 'utf8').trim();
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (exists) {
    try { chmodSync(file, 0o600); } catch { /* identity is not secret; permissions are defense-in-depth */ }
  }
  if (existing) return existing;
  const id = `forgejo-ops-widget-${randomUUID().slice(0, 8)}`;
  mkdirSync(confDir, { recursive: true });
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* see above */ }
  return id;
}
