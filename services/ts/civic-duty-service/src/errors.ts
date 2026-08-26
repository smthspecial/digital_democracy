export class DomainError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
  }
}

export function notFound(message: string): DomainError {
  return new DomainError(404, message);
}

export function conflict(message: string): DomainError {
  return new DomainError(409, message);
}

export function forbidden(message: string): DomainError {
  return new DomainError(403, message);
}

export function validation(message: string): DomainError {
  return new DomainError(400, message);
}
