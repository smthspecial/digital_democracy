import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import {
  ConflictDomainError,
  ForbiddenDomainError,
  InvalidStateDomainError,
  NotFoundDomainError,
} from "./domain-errors.js";

// Keyed by error.constructor below, which TypeScript types as the built-in `Function`; no narrower type exists.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const STATUS_BY_ERROR = new Map<Function, number>([
  [NotFoundDomainError, HttpStatus.NOT_FOUND],
  [ConflictDomainError, HttpStatus.CONFLICT],
  [ForbiddenDomainError, HttpStatus.FORBIDDEN],
  [InvalidStateDomainError, HttpStatus.UNPROCESSABLE_ENTITY],
]);

// AUTH-010's enforcement contract: "on any failure, reject with a structured
// error (no leaking of which guard failed)" -- domain errors map to a status
// + stable `code` + message, nothing about which internal check tripped.
@Catch(NotFoundDomainError, ConflictDomainError, ForbiddenDomainError, InvalidStateDomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = STATUS_BY_ERROR.get(error.constructor) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({
      error: { code: error.name, message: error.message },
    });
  }
}
