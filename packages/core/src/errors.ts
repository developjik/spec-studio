/** Shared domain error: the store maps `code` onto an HTTP 400. */
export type DomainErrorCode =
  | 'screen_missing'
  | 'screen_mismatch'
  | 'pin_not_found'
  | 'doc_missing'
  | 'block_not_found'
  | 'proposal_missing'
  | 'proposal_decided'
  | 'node_not_found'
  | 'run_missing'
  | 'invalid_input';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
