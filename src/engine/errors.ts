/**
 * Errors the engine raises. The engine knows nothing about HTTP; the API's exception
 * filter maps each kind to a status code in one place.
 */
export type DomainErrorKind =
  | 'not_found' // 404
  | 'invalid' // 400
  | 'unprocessable' // 422: well-formed but not allowed (e.g. key reused with another body, > 50k)
  | 'busy'; // 503: a row lock could not be taken in time; safe to retry

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string): DomainError => new DomainError('not_found', `${what} not found`);
