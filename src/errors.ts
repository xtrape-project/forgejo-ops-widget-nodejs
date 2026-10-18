export type WidgetActionErrorCode =
  | 'VALIDATION_FAILED'
  | 'PRECONDITION_FAILED';

/**
 * A bounded, credential-free error that is safe to project over the CE Action
 * boundary. Transport errors remain owned and normalized by forgejo-api.
 */
export class WidgetActionError extends Error {
  readonly retryable = false;

  constructor(readonly code: WidgetActionErrorCode, message: string) {
    super(message);
    this.name = 'WidgetActionError';
  }
}
