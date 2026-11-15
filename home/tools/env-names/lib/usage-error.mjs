// The one error class the CLI turns into exit 2. Its message is a plain reason written by this tool: it never carries text
// from an env file, a snapshot or an error object of another library (those can echo file content). Control characters
// (a path may hold a newline) are replaced by `?` so a message cannot forge extra lines.
// Exports: UsageError.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export class UsageError extends Error {
  constructor(message) {
    super(message.replace(CONTROL_CHARACTERS, '?'));
  }
}
