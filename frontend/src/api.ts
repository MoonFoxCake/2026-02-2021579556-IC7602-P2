const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Account = { id: string; email: string }
type LoginResponse = { token: string; expiresIn: number }
export type Session = { user: Account }
export type Domain = { domain: string; verified: boolean; verifiedAt: string | null; createdAt: string | null; txt?: { type: string; name: string; value: string } }
export type FileTypeTtl = { ext: string; ttlSeconds: number }
export type UrlRule = { id: string; domain: string; pattern: string; origin: string; cacheSizeMB: number; fileTypes: FileTypeTtl[]; replacementPolicy: 'LRU' | 'LFU' | 'FIFO' | 'MRU' | 'RANDOM'; authType: 'none' | 'apikey' | 'userpass'; createdAt: string | null }
export type ApiKey = { id: string; prefix: string; createdAt: string | null }
export type CreatedApiKey = ApiKey & { apiKey: string }
export type UrlUser = { username: string; createdAt: string | null }
export type UrlRuleInput = Omit<UrlRule, 'id' | 'domain' | 'createdAt'>
export type CacheTestInput = { urlId: string; host: string; path: string; zone?: string }
export type CacheTestResult = { status: number; elapsedMs: number; headers: Record<string, string>; body: string; truncated: boolean; requiresLogin: boolean }

let token: string | null = null

async function request<T>(path: string, method = 'GET', body?: unknown, account = true): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(account && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('No se pudo conectar con la Node API. Revisa VITE_API_BASE_URL y CORS.')
  }

  if (account && response.status === 401) token = null
  if (!response.ok) {
    let message = `La API respondió con el estado ${response.status}.`
    try {
      const payload = (await response.json()) as { error?: unknown; message?: unknown }
      if (typeof payload.error === 'string') message = payload.error
      else if (typeof payload.message === 'string') message = payload.message
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

export const api = {
  authorizeCache: (input: { domain: string; pattern: string; callback: string; returnTo: string; username: string; password: string }) => request<{ redirectUrl: string }>('/cache-login', 'POST', input, false),
  cacheTestStatus: () => request<{ enabled: boolean; zones: string[] }>('/cache-test/status'),
  testCache: (input: CacheTestInput & { apiKey?: string }) => request<CacheTestResult>('/cache-test/request', 'POST', input),
  loginCache: (input: CacheTestInput & { username: string; password: string }) => request<{ authenticated: boolean; status: number; message: string }>('/cache-test/login', 'POST', input),
  logoutCache: (input: CacheTestInput) => request<{ authenticated: boolean }>('/cache-test/logout', 'POST', input),
  health: async () => (await request<{ ok: boolean }>('/health')).ok,
  register: (email: string, password: string) => request<Account>('/auth/register', 'POST', { email, password }),
  async login(email: string, password: string): Promise<Session> {
    const result = await request<LoginResponse>('/auth/login', 'POST', { email, password })
    token = result.token
    try {
      return { user: await request<Account>('/auth/me') }
    } catch (error) {
      token = null
      throw error
    }
  },
  logout(): void { token = null },
  listDomains: async () => (await request<{ domains: Domain[] }>('/domains')).domains,
  createDomain: (domain: string) => request<Domain & { instructions: string }>('/domains', 'POST', { domain }),
  verifyDomain: (domain: string) => request<Domain & { message?: string }>('/domains/' + encodeURIComponent(domain) + '/verify', 'POST'),
  deleteDomain: (domain: string) => request<{ deleted: boolean; domain: string }>('/domains/' + encodeURIComponent(domain), 'DELETE'),
  listUrls: async (domain: string) => (await request<{ urls: UrlRule[] }>('/domains/' + encodeURIComponent(domain) + '/urls')).urls,
  createUrl: (domain: string, input: UrlRuleInput) => request<UrlRule>('/domains/' + encodeURIComponent(domain) + '/urls', 'POST', input),
  updateUrl: (id: string, input: Partial<UrlRuleInput>) => request<UrlRule>('/urls/' + encodeURIComponent(id), 'PUT', input),
  deleteUrl: (id: string) => request<{ deleted: boolean; id: string }>('/urls/' + encodeURIComponent(id), 'DELETE'),
  listApiKeys: async (id: string) => (await request<{ apiKeys: ApiKey[] }>('/urls/' + encodeURIComponent(id) + '/api-keys')).apiKeys,
  createApiKey: (id: string) => request<CreatedApiKey>('/urls/' + encodeURIComponent(id) + '/api-keys', 'POST', {}),
  deleteApiKey: (id: string) => request<{ deleted: boolean }>('/api-keys/' + encodeURIComponent(id), 'DELETE'),
  listUsers: async (id: string) => (await request<{ users: UrlUser[] }>('/urls/' + encodeURIComponent(id) + '/users')).users,
  createUser: (id: string, username: string, password: string) => request<UrlUser>('/urls/' + encodeURIComponent(id) + '/users', 'POST', { username, password }),
  updateUser: (id: string, username: string, password: string) => request<{ username: string; updated: boolean }>('/urls/' + encodeURIComponent(id) + '/users/' + encodeURIComponent(username), 'PUT', { password }),
  deleteUser: (id: string, username: string) => request<{ deleted: boolean }>('/urls/' + encodeURIComponent(id) + '/users/' + encodeURIComponent(username), 'DELETE'),
}
