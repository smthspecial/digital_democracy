export class DomainError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
  }
}

export function notFound(message = "Not found"): DomainError {
  return new DomainError(message, 404);
}

export function conflict(message = "Conflict"): DomainError {
  return new DomainError(message, 409);
}

export function forbidden(message = "Forbidden"): DomainError {
  return new DomainError(message, 403);
}

export function validation(message = "Validation failed"): DomainError {
  return new DomainError(message, 400);
}
