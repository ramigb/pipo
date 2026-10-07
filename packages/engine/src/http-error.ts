// An API error with its HTTP status (docs/spec.md §7.1, D28): served as `{error, hint, code, ...extra}`.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint: string,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
