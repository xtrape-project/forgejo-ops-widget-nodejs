import type { ForgejoOpenApiClient } from '@xtrape/forgejo-api';

export type Capability =
  | 'forgejo.inspect'
  | 'forgejo.collaborate'
  | 'forgejo.content'
  | 'forgejo.governance'
  | 'forgejo.administration'
  /** The Service's own configuration (forgejo-ops#32): which Forgejo it points at. */
  | 'forgejo.target';
export type CredentialProfile = 'collaboration' | 'administration';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type SideEffect = 'none' | 'write' | 'destructive';

/**
 * Widget-local projection metadata for the future canonical Checkpoint.
 * This is deliberately not named/typed as the strict contracts
 * CheckpointDefinition: Connector 0.8.1 cannot yet publish schema records,
 * extractor artifacts, or Checkpoint definitions to Platform.
 */
export interface CheckpointMetadata {
  id: string;
  version: string;
  resourceType: string;
  risk: RiskLevel;
  sideEffect: SideEffect;
  credentialProfile: CredentialProfile;
  localPreconditions: readonly string[];
}

export interface ActionContext {
  client: ForgejoOpenApiClient;
  signal?: AbortSignal;
}

export interface ActionDefinition {
  name: string;
  version: string;
  label: string;
  description: string;
  capability: Capability;
  credentialProfile: CredentialProfile;
  checkpoint: CheckpointMetadata;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ActionContext): Promise<Record<string, unknown>>;
}

export interface CredentialSet {
  collaboration: string;
  administration?: string;
}

export interface ForgejoTarget {
  id: string;
  baseUrl: string;
  credentials: CredentialSet;
}
