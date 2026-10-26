export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus = 422,
  ) {
    super(code);
  }
}

export function ensure(condition: unknown, code: string, status = 422): asserts condition {
  if (!condition) throw new AppError(code, status);
}
