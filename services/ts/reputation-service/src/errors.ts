export class DomainError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
  }
}

export function validationError(message: string): DomainError {
  return new DomainError(message, 400);
}
