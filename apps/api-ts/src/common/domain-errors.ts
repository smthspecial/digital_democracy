// Domain-level errors, mapped to HTTP responses in http-exception.filter.ts.
// Kept separate from Nest's HttpException so repository/service unit tests
// (which never touch HTTP) can assert on these directly.

export class NotFoundDomainError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "NotFoundDomainError";
  }
}

export class ConflictDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictDomainError";
  }
}

export class ForbiddenDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenDomainError";
  }
}

export class InvalidStateDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateDomainError";
  }
}
