import type { ForgejoOpenApiClient } from '@xtrape/forgejo-api';
import type { ActionDefinition, CheckpointMetadata } from './types.js';

const REASON = { reason: { type: 'string', minLength: 1, maxLength: 2_000 } } as const;
function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
function string(input: Record<string, unknown>, key: string): string {
  const value = input[key]; if (typeof value !== 'string') throw new Error(`${key} must be a string`); return value;
}
function int(input: Record<string, unknown>, key: string): number {
  const value = input[key]; if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`); return value;
}
function data<T>(response: { data?: T }): T {
  if (response.data === undefined) throw new Error('Forgejo returned no response data'); return response.data;
}
function checkpoint(id: string, resourceType: string, preconditions: string[]): CheckpointMetadata {
  return { id, version: '1.0.0', resourceType, risk: 'high', sideEffect: 'write', credentialProfile: 'administration',
    localPreconditions: ['schema-valid', 'human-reason', ...preconditions] };
}
async function assertTeamOrganization(client: ForgejoOpenApiClient, teamId: number, organization: string, signal?: AbortSignal) {
  const team = data(await client.GET('/teams/{id}', { params: { path: { id: teamId } }, ...(signal ? { signal } : {}) }));
  if (team.organization?.username !== organization) throw new Error('team does not belong to the expected organization');
  return team;
}

export function buildAdministrationActions(): ActionDefinition[] {
  return [
    {
      name: 'createOrganization', version: '1.0.0', label: 'Create Organization',
      description: 'Create one organization with an explicit visibility; no user impersonation is allowed.',
      capability: 'forgejo.administration', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.administration.organization.create', 'forgejo.organization', ['explicit-visibility']),
      inputSchema: schema({ ...REASON, username: { type: 'string', minLength: 1, maxLength: 255 },
        fullName: { type: 'string', maxLength: 255 }, description: { type: 'string', maxLength: 4_096 },
        visibility: { enum: ['public', 'limited', 'private'] },
      }, ['username', 'visibility', 'reason']),
      async execute(input, { client, signal }) {
        const username = string(input, 'username'); const visibility = string(input, 'visibility') as 'public' | 'limited' | 'private';
        const organization = data(await client.POST('/orgs', { body: { username, visibility,
          ...(typeof input.fullName === 'string' ? { full_name: input.fullName } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}) }, ...(signal ? { signal } : {}) }));
        return { username: organization.username, fullName: organization.full_name, description: organization.description,
          visibility: organization.visibility, location: organization.location, website: organization.website };
      },
    },
    {
      name: 'createOrganizationRepository', version: '1.0.0', label: 'Create Organization Repository',
      description: 'Create a repository in one explicit organization with bounded initialization options.',
      capability: 'forgejo.administration', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.administration.organization-repository.create', 'forgejo.repository', ['explicit-organization', 'explicit-privacy']),
      inputSchema: schema({ ...REASON, organization: { type: 'string', minLength: 1, maxLength: 255 },
        name: { type: 'string', minLength: 1, maxLength: 255 }, description: { type: 'string', maxLength: 4_096 },
        private: { type: 'boolean' }, defaultBranch: { type: 'string', minLength: 1, maxLength: 255, default: 'main' },
        autoInit: { type: 'boolean', default: false },
      }, ['organization', 'name', 'private', 'reason']),
      async execute(input, { client, signal }) {
        const organization = string(input, 'organization'); const name = string(input, 'name');
        const repository = data(await client.POST('/orgs/{org}/repos', { params: { path: { org: organization } },
          body: { name, private: input.private === true, default_branch: typeof input.defaultBranch === 'string' ? input.defaultBranch : 'main',
            auto_init: input.autoInit === true, ...(typeof input.description === 'string' ? { description: input.description } : {}) },
          ...(signal ? { signal } : {}) }));
        return { id: repository.id, name: repository.name, fullName: repository.full_name, private: repository.private,
          defaultBranch: repository.default_branch, url: repository.html_url };
      },
    },
    {
      name: 'createTeam', version: '1.0.0', label: 'Create Team',
      description: 'Create a team with an explicit bounded permission and without implicit all-repository access.',
      capability: 'forgejo.administration', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.administration.team.create', 'forgejo.team', ['explicit-permission', 'no-all-repositories']),
      inputSchema: schema({ ...REASON, organization: { type: 'string', minLength: 1, maxLength: 255 },
        name: { type: 'string', minLength: 1, maxLength: 255 }, description: { type: 'string', maxLength: 4_096 },
        permission: { enum: ['read', 'write', 'admin'] }, canCreateRepositories: { type: 'boolean', default: false },
      }, ['organization', 'name', 'permission', 'reason']),
      async execute(input, { client, signal }) {
        const organization = string(input, 'organization'); const name = string(input, 'name');
        const permission = string(input, 'permission') as 'read' | 'write' | 'admin';
        const team = data(await client.POST('/orgs/{org}/teams', { params: { path: { org: organization } },
          body: { name, permission, includes_all_repositories: false, can_create_org_repo: input.canCreateRepositories === true,
            ...(typeof input.description === 'string' ? { description: input.description } : {}) }, ...(signal ? { signal } : {}) }));
        return { id: team.id, name: team.name, organization: team.organization?.username, permission: team.permission,
          canCreateRepositories: team.can_create_org_repo, includesAllRepositories: team.includes_all_repositories };
      },
    },
    {
      name: 'addTeamMember', version: '1.0.0', label: 'Add Team Member',
      description: 'Add one existing user to a team after verifying the team organization.',
      capability: 'forgejo.administration', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.administration.team-member.add', 'forgejo.team-member', ['team-organization-binding']),
      inputSchema: schema({ ...REASON, organization: { type: 'string', minLength: 1, maxLength: 255 },
        teamId: { type: 'integer', minimum: 1 }, username: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['organization', 'teamId', 'username', 'reason']),
      async execute(input, { client, signal }) {
        const organization = string(input, 'organization'); const teamId = int(input, 'teamId'); const username = string(input, 'username');
        await assertTeamOrganization(client, teamId, organization, signal);
        await client.PUT('/teams/{id}/members/{username}', { params: { path: { id: teamId, username } }, ...(signal ? { signal } : {}) });
        return { organization, teamId, username, added: true };
      },
    },
    {
      name: 'addTeamRepository', version: '1.0.0', label: 'Add Repository to Team',
      description: 'Grant a team its declared permission to one repository in the same verified organization.',
      capability: 'forgejo.administration', credentialProfile: 'administration',
      checkpoint: checkpoint('forgejo.administration.team-repository.add', 'forgejo.team-repository', ['team-organization-binding']),
      inputSchema: schema({ ...REASON, organization: { type: 'string', minLength: 1, maxLength: 255 },
        teamId: { type: 'integer', minimum: 1 }, repository: { type: 'string', minLength: 1, maxLength: 255 },
      }, ['organization', 'teamId', 'repository', 'reason']),
      async execute(input, { client, signal }) {
        const organization = string(input, 'organization'); const teamId = int(input, 'teamId'); const repository = string(input, 'repository');
        await assertTeamOrganization(client, teamId, organization, signal);
        await client.PUT('/teams/{id}/repos/{org}/{repo}', {
          params: { path: { id: teamId, org: organization, repo: repository } }, ...(signal ? { signal } : {}),
        });
        return { organization, teamId, repository, added: true };
      },
    },
  ];
}
