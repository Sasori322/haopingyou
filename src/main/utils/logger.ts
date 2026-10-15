const PREFIX = '[好屏友]'

function fmt(scope: string, args: unknown[]): unknown[] {
  return [`${PREFIX}[${scope}]`, ...args]
}

export function createLogger(scope: string) {
  return {
    info: (...args: unknown[]): void => console.log(...fmt(scope, args)),
    warn: (...args: unknown[]): void => console.warn(...fmt(scope, args)),
    error: (...args: unknown[]): void => console.error(...fmt(scope, args))
  }
}
