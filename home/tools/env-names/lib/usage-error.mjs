// The one error class the CLI turns into exit 2. Its message is a plain reason written by this tool: it never carries text
// from an env file, a snapshot or an error object of another library (those can echo file content).
// Exports: UsageError.
export class UsageError extends Error {}
