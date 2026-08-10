import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[] | undefined>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function validationError(error: ZodError): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', error.flatten().fieldErrors);
}
