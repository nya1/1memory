import { nanoid } from "nanoid";
import { JustMemoryError } from "./errors.js";
import { SCHEMA_VERSION, Scope } from "./types.js";

export interface SuccessEnvelope<T> {
  ok: true;
  request_id: string;
  schema_version: string;
  profile_id?: string;
  scope?: Scope;
  data: T;
  warnings: string[];
  errors: [];
  write_state?: string;
  indexing_state?: string;
}

export interface FailureEnvelope {
  ok: false;
  request_id: string;
  schema_version: string;
  error: {
    code: string;
    message: string;
    action: string;
    details?: Record<string, unknown>;
  };
  warnings: string[];
}

export function newRequestId(): string {
  return `req_${nanoid(16)}`;
}

export function success<T>(
  data: T,
  options: {
    request_id?: string;
    profile_id?: string;
    scope?: Scope;
    warnings?: string[];
    write_state?: string;
    indexing_state?: string;
  } = {}
): SuccessEnvelope<T> {
  return {
    ok: true,
    request_id: options.request_id ?? newRequestId(),
    schema_version: SCHEMA_VERSION,
    profile_id: options.profile_id,
    scope: options.scope,
    data,
    warnings: options.warnings ?? [],
    errors: [],
    write_state: options.write_state,
    indexing_state: options.indexing_state
  };
}

export function failure(error: unknown, requestId = newRequestId()): FailureEnvelope {
  if (error instanceof JustMemoryError) {
    return {
      ok: false,
      request_id: requestId,
      schema_version: SCHEMA_VERSION,
      error: {
        code: error.code,
        message: error.message,
        action: error.action,
        details: error.details
      },
      warnings: []
    };
  }

  return {
    ok: false,
    request_id: requestId,
    schema_version: SCHEMA_VERSION,
    error: {
      code: "backend_degraded",
      message: error instanceof Error ? error.message : "Unexpected local backend error.",
      action: "Inspect local JustMemory logs and retry the request."
    },
    warnings: []
  };
}
