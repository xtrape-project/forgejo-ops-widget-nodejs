import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { WidgetActionError } from './errors.js';
import type { ActionDefinition } from './types.js';

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition>();
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(definitions: readonly ActionDefinition[]) {
    const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
    (addFormats as unknown as (instance: Ajv) => Ajv)(ajv);
    const checkpoints = new Set<string>();
    for (const definition of definitions) {
      const actionCoordinate = `${definition.name}@${definition.version}`;
      const checkpointCoordinate = `${definition.checkpoint.id}@${definition.checkpoint.version}`;
      if (this.actions.has(definition.name)) throw new Error(`duplicate Action owner: ${definition.name}`);
      if (checkpoints.has(checkpointCoordinate)) throw new Error(`duplicate Checkpoint owner: ${checkpointCoordinate}`);
      if (definition.credentialProfile !== definition.checkpoint.credentialProfile) {
        throw new Error(`credential profile mismatch for ${actionCoordinate}`);
      }
      this.actions.set(definition.name, definition);
      checkpoints.add(checkpointCoordinate);
      this.validators.set(definition.name, ajv.compile(definition.inputSchema));
    }
  }

  list(): ActionDefinition[] {
    return [...this.actions.values()];
  }

  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  validate(name: string, raw: unknown): Record<string, unknown> {
    const validate = this.validators.get(name);
    if (!validate) throw new WidgetActionError('VALIDATION_FAILED', `unknown Action "${name}"`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new WidgetActionError('VALIDATION_FAILED', 'Action input must be an object');
    }
    if (!validate(raw)) {
      const details = (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
      throw new WidgetActionError('VALIDATION_FAILED', `Action input validation failed: ${details}`);
    }
    return raw as Record<string, unknown>;
  }
}
