export class RayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, options?: { code?: string; status?: number; details?: unknown }) {
    super(message);
    this.name = "RayError";
    this.code = options?.code ?? "ray_error";
    this.status = options?.status ?? 500;
    this.details = options?.details;
  }
}
