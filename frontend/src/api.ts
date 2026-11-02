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

let token: string | null = null

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('No se pudo conectar con la Node API. Revisa VITE_API_BASE_URL y CORS.')
  }

  if (response.status === 401) token = null
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
  logout(): void {
    token = null
  },
}
