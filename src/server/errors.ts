export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "DISK_FULL"
  | "BUSY"
  | "FORBIDDEN_PATH"
  | "JOB_FAILED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  DISK_FULL: 409,
  BUSY: 409,
  FORBIDDEN_PATH: 403,
  JOB_FAILED: 500,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | null;

  constructor(code: ErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }

  toJSON(): { error: { code: ErrorCode; message: string; detail: string | null } } {
    return { error: { code: this.code, message: this.message, detail: this.detail } };
  }
}

export const badRequest = (m: string, d?: string) => new ApiError("BAD_REQUEST", m, d ?? null);
export const notFound = (m: string) => new ApiError("NOT_FOUND", m);
export const forbiddenPath = (m: string) => new ApiError("FORBIDDEN_PATH", m);
export const diskFull = (m: string) => new ApiError("DISK_FULL", m);
