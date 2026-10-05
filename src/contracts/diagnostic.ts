export type ErrorCode
  = | 'ProviderNotFound'
    | 'SessionNotFound'
    | 'PermissionDenied'
    | 'UnsupportedSchema'
    | 'CorruptedSession'
    | 'PartialParse'
    | 'IOError'
    | 'DatabaseError'
export interface Diagnostic {
  readonly code: ErrorCode
  readonly message: string
  readonly position?: number
}
export class SessionError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionError'
    this.code = code
  }
}
