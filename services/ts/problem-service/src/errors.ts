export class DomainError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
  }
}

export function notFound(message: string): DomainError {
  return new DomainError(message, 404);
}

export function conflict(message: string): DomainError {
  return new DomainError(message, 409);
}

export function forbidden(message: string): DomainError {
  return new DomainError(message, 403);
}

export function validation(message: string): DomainError {
  return new DomainError(message, 400);
}
