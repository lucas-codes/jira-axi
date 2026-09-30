export class JiraError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  details: { applied?: boolean | 'unknown'; fields?: {field: string; message: string}[]; errorMessages?: string[]; retryAfter?: number; limitReason?: string } = {};

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.name = 'JiraError';
    this.code = code;
    this.hint = hint;
  }
}
