const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export type Session = { user: { id: string; email: string } }
export type Domain = {
  id: string
  hostname: string
  verified: boolean
  verification?: { name: string; value: string }
}
export type FileTypePolicy = { extension: string; ttlSeconds: number }
export type UrlRule = {
  id: string
  pattern: string
  cacheSizeMb: number
  fileTypes: FileTypePolicy[]
  replacementPolicy: 'LRU' | 'LFU' | 'FIFO' | 'MRU' | 'Random'
  authMode: 'api-key' | 'credentials'
}
export type ManagedUser = { id: string; username: string }
export type ApiKey = { id: string; label: string; prefix: string; secret?: string }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('No se pudo conectar con la API. La integración está pendiente.')
  }

  if (!response.ok) {
    let message = `La API respondió con el estado ${response.status}.`
    try {
      const payload = (await response.json()) as { message?: string }
      if (payload.message) message = payload.message
    } catch {
      // Keep the HTTP status message when the API does not return JSON.
    }
    throw new ApiError(message, response.status)
  }

  if (response.status === 204) return undefined as T
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError('La API respondió con un formato no válido.', response.status)
  }
}

const id = (value: string) => encodeURIComponent(value)

export const api = {
  session: () => request<Session>('/auth/session'),
  register: (email: string, password: string) => request<Session>('/auth/register', 'POST', { email, password }),
  login: (email: string, password: string) => request<Session>('/auth/login', 'POST', { email, password }),
  logout: () => request<void>('/auth/logout', 'POST'),
  domains: () => request<Domain[]>('/domains'),
  createDomain: (hostname: string) => request<Domain>('/domains', 'POST', { hostname }),
  deleteDomain: (domainId: string) => request<void>(`/domains/${id(domainId)}`, 'DELETE'),
  verifyDomain: (domainId: string) => request<{ verified: boolean }>(`/domains/${id(domainId)}/verify`, 'POST'),
  rules: (domainId: string) => request<UrlRule[]>(`/domains/${id(domainId)}/urls`),
  createRule: (domainId: string, rule: Omit<UrlRule, 'id'>) => request<UrlRule>(`/domains/${id(domainId)}/urls`, 'POST', rule),
  updateRule: (domainId: string, ruleId: string, rule: Omit<UrlRule, 'id'>) => request<UrlRule>(`/domains/${id(domainId)}/urls/${id(ruleId)}`, 'PUT', rule),
  deleteRule: (domainId: string, ruleId: string) => request<void>(`/domains/${id(domainId)}/urls/${id(ruleId)}`, 'DELETE'),
  users: (domainId: string, ruleId: string) => request<ManagedUser[]>(`/domains/${id(domainId)}/urls/${id(ruleId)}/users`),
  createUser: (domainId: string, ruleId: string, username: string, password: string) => request<ManagedUser>(`/domains/${id(domainId)}/urls/${id(ruleId)}/users`, 'POST', { username, password }),
  updateUser: (domainId: string, ruleId: string, userId: string, update: { username?: string; password?: string }) => request<void>(`/domains/${id(domainId)}/urls/${id(ruleId)}/users/${id(userId)}`, 'PUT', update),
  deleteUser: (domainId: string, ruleId: string, userId: string) => request<void>(`/domains/${id(domainId)}/urls/${id(ruleId)}/users/${id(userId)}`, 'DELETE'),
  keys: (domainId: string, ruleId: string) => request<ApiKey[]>(`/domains/${id(domainId)}/urls/${id(ruleId)}/api-keys`),
  createKey: (domainId: string, ruleId: string, label: string) => request<ApiKey>(`/domains/${id(domainId)}/urls/${id(ruleId)}/api-keys`, 'POST', { label }),
  deleteKey: (domainId: string, ruleId: string, keyId: string) => request<void>(`/domains/${id(domainId)}/urls/${id(ruleId)}/api-keys/${id(keyId)}`, 'DELETE'),
}
