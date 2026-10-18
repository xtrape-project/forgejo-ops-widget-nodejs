/**
 * Widget Design Conventions §5 (xtrape-docs#287, owner 2026-09-06): an AI
 * host sees ONLY the admitted input schema and a description. Every governed
 * Action therefore carries its description at the schema root and a
 * description on every declared field, nested object members included.
 * Found live on 2026-09-06: repository.get projected as `{"type":"object"}`.
 */
import { describe, expect, it } from 'vitest';
import { buildActionCatalog } from '../src/actions.js';
import { STATIC_CHECKPOINT_ROWS } from '../src/checkpoints.js';
import { buildTargetCeActions } from '../src/target-actions.js';
import { TargetStore } from '../src/target-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function undescribed(schema: Record<string, unknown>, path = ''): string[] {
  const out: string[] = [];
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  for (const [k, v] of Object.entries(props ?? {})) {
    const d = v['description'];
    if (typeof d !== 'string' || d.trim() === '') out.push(`${path}${k}`);
    // panel-ce#193 #4: a human label too — the Panel renders `title ?? key`.
    if (typeof v['title'] !== 'string' || (v['title'] as string).trim() === '') out.push(`${path}${k} (no title)`);
    if (v['type'] === 'object') out.push(...undescribed(v, `${path}${k}.`));
    const items = v['items'] as Record<string, unknown> | undefined;
    if (items && items['type'] === 'object') out.push(...undescribed(items, `${path}${k}[].`));
  }
  return out;
}

describe('governed Actions are self-describing to an AI host', () => {
  const governed = new Set(STATIC_CHECKPOINT_ROWS.map((r) => r.action));
  const catalog = buildActionCatalog().filter((a) => governed.has(a.name));
  const store = new TargetStore(mkdtempSync(join(tmpdir(), 'fops-desc-')), 'svc');
  const target = buildTargetCeActions({ store, refFor: (n) => ({ serviceId: 'svc', checkpointId: n, checkpointVersion: '1.0.0' }), exposed: () => true });

  it('covers every governed row', () => {
    const names = new Set([...catalog.map((a) => a.name), ...target.map((a) => a.name)]);
    expect([...governed].filter((n) => !names.has(n))).toEqual([]);
  });

  it.each([...catalog, ...target].map((a) => [a.name, a] as const))('%s: title + description at the schema root, every field titled and described', (_name, a) => {
    const schema = a.inputSchema as Record<string, unknown>;
    expect(typeof schema['description']).toBe('string');
    expect(typeof schema['title']).toBe('string');
    expect((schema['description'] as string).trim()).not.toBe('');
    expect(undescribed(schema)).toEqual([]);
  });
});
