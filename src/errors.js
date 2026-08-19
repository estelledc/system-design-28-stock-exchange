export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status = 400) {
  throw new DomainError(code, message, status);
}

export function asDomainError(error) {
  if (error instanceof DomainError) return error;
  if (error?.code === '23514') {
    return new DomainError('invariant_violation', 'database integrity constraint rejected the operation', 500);
  }
  if (error?.code === '23505') {
    return new DomainError('intent_conflict', 'identity is already bound to another immutable fact', 409);
  }
  return new DomainError('internal_error', 'unexpected local failure', 500);
}
