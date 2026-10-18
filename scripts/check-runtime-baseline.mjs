import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.forgejo/workflows/ci.yml', import.meta.url), 'utf8');
const integrationWorkflow = readFileSync(new URL('../.forgejo/workflows/forgejo-integration.yml', import.meta.url), 'utf8');
const failures = [];
if (packageJson.engines?.node !== '>=24') failures.push('package engines.node must be >=24');
if (!dockerfile.includes('node:24-bookworm-slim@sha256:')) failures.push('Docker base must pin Node 24 by digest');
if (!dockerfile.includes('USER node')) failures.push('runtime container must be non-root');
if (!dockerfile.includes('HEALTHCHECK')) failures.push('runtime container must define a health check');
if (!workflow.includes('node:24-bookworm@sha256:')) failures.push('CI container must pin Node 24 by digest');
if (!integrationWorkflow.includes('codeberg.org/forgejo/forgejo@sha256:')) failures.push('integration Forgejo image must be pinned by digest');
for (const dependency of ['@xtrape/connector', '@xtrape/contracts', '@xtrape/forgejo-api']) {
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.dependencies?.[dependency] ?? '')) failures.push(`${dependency} must use an exact version`);
}
if (failures.length) throw new Error(failures.join('\n'));
process.stdout.write('runtime baseline is internally consistent\n');
