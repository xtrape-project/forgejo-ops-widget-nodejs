import { buildActionCatalog } from '../dist/actions.js';
import { buildCeActions } from '../dist/service.js';
import { ForgejoClientProvider } from '../dist/credentials.js';

const actions = buildActionCatalog();
const expectedCounts = { 'forgejo.inspect': 25, 'forgejo.collaborate': 12, 'forgejo.content': 4, 'forgejo.governance': 14, 'forgejo.administration': 5 };
const names = new Set(); const checkpoints = new Set();
for (const action of actions) {
  const coordinate = `${action.name}@${action.version}`;
  const checkpoint = `${action.checkpoint.id}@${action.checkpoint.version}`;
  if (names.has(coordinate)) throw new Error(`duplicate Action ${coordinate}`);
  if (checkpoints.has(checkpoint)) throw new Error(`duplicate Checkpoint ${checkpoint}`);
  names.add(coordinate); checkpoints.add(checkpoint);
  if (action.credentialProfile !== action.checkpoint.credentialProfile) throw new Error(`profile mismatch: ${coordinate}`);
  if (['forgejo.inspect', 'forgejo.collaborate', 'forgejo.content'].includes(action.capability) && action.credentialProfile !== 'collaboration') {
    throw new Error(`ordinary Action received administration profile: ${coordinate}`);
  }
}
for (const [capability, count] of Object.entries(expectedCounts)) {
  const actual = actions.filter((action) => action.capability === capability).length;
  if (actual !== count) throw new Error(`${capability}: expected ${count}, got ${actual}`);
}
// The DEFAULT served runtime surface is exactly the bounded read-only reference
// Checkpoints (#7 trio + #16's context snapshot) — never a write/administration
// Action. Every Phase B / #10 write is served only when the allowlist names it.
const provider = new ForgejoClientProvider({ id: 't', baseUrl: 'https://forgejo.example.test', credentials: { collaboration: 'tok' } });
const projected = buildCeActions({ serviceId: 'forgejo-ops-widget-nodejs', provider });
const projectedNames = projected.map((a) => a.name).sort();
// The default READ surface: the four reference reads plus the four list-first
// reads (panel-ce#193 #3 / #9; owner 2026-09-06).
const expectedRead = ['getIssue', 'getPullRequest', 'getPullRequestContext', 'getRepository', 'listIssues', 'listOrganizations', 'listPullRequests', 'listRepositories'];
if (JSON.stringify(projectedNames) !== JSON.stringify(expectedRead)) {
  throw new Error(`runtime surface must be exactly ${expectedRead.join(', ')}; got ${projectedNames.join(', ') || '(none)'}`);
}
for (const action of projected) {
  if (!action.checkpoint) throw new Error(`served Action ${action.name} binds no Checkpoint`);
}
process.stdout.write(`catalog verified: ${actions.length} dormant inventory entries; ${projected.length} bounded read-only runtime Checkpoints (${projectedNames.join(', ')})\n`);
