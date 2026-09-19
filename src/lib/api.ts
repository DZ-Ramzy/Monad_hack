/**
 * Where the API lives.
 *
 * Empty by default, which keeps every call same-origin and relative - the
 * shape the Vite dev proxy and a single-process deploy both already expect,
 * and the shape a static host uses when it rewrites /api/* to the server.
 *
 * Set VITE_API_BASE at build time only when the browser must talk to the
 * server's origin directly. That is a cross-origin call, so the server has to
 * allow it back via ALLOWED_ORIGIN.
 */
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

export const api = (path: string) => `${BASE}${path}`
