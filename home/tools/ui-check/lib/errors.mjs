// Purpose: one error type for usage and setup problems (exit code 2).
// Exports: UsageError. Invariant: only throw it for caller mistakes or missing setup, never for check failures.

/** Raised for bad flags, missing files, missing Playwright/odiff or a missing token. Maps to exit code 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}
