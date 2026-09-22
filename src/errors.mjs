export const EXIT = Object.freeze({
  OK: 0,
  VIOLATION: 1,
  USAGE: 2,
  AUTHORITY: 3,
  TOOL: 4,
});

export class DebtGateError extends Error {
  constructor(message, exitCode, details = {}, kind = 'debt-gate') {
    super(message);
    this.name = 'DebtGateError';
    this.exitCode = exitCode;
    this.details = details;
    this.kind = kind;
  }
}

export const usageError = (message, details) => new DebtGateError(message, EXIT.USAGE, details, 'usage');
export const authorityError = (message, details) => new DebtGateError(message, EXIT.AUTHORITY, details, 'authority');
export const toolError = (message, details) => new DebtGateError(message, EXIT.TOOL, details, 'tool');
