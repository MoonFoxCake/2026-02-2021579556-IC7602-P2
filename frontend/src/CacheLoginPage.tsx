import { useState, type FormEvent } from 'react'
import { api } from './api'

export function CacheLoginPage() {
  const params = new URLSearchParams(window.location.search)
  const domain = params.get('domain') || ''
  const pattern = params.get('pattern') || ''
  const callback = params.get('callback') || ''
  const returnTo = params.get('return_to') || ''
  const complete = Boolean(domain && pattern && callback && returnTo)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await api.authorizeCache({ domain, pattern, callback, returnTo, username, password })
      window.location.assign(result.redirectUrl)
    } catch (err) {
      setPassword(''); setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión.')
    }
  }

  return <main className="mx-auto grid min-h-screen max-w-md content-center px-5 py-12">
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-sm font-semibold text-indigo-700">Caché zonal · Acceso al recurso</p>
      <h1 className="mt-2 text-2xl font-semibold">Iniciar sesión</h1>
      {complete ? <>
        <p className="mt-3 break-words text-sm text-slate-600">Accede a <strong>{domain}</strong> con el usuario y la contraseña asignados a este recurso.</p>
        <p className="mt-2 break-all text-sm text-slate-500">{returnTo}</p>
        <form className="mt-6 grid gap-4" onSubmit={(event) => { void submit(event) }}>
          <label className="grid gap-1 text-sm font-medium">Usuario<input className="control" autoComplete="username" maxLength={64} required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="grid gap-1 text-sm font-medium">Contraseña<input className="control" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button disabled={busy} className="min-h-11 rounded-xl bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{busy ? 'Verificando…' : 'Acceder al recurso'}</button>
        </form>
      </> : <p role="alert" className="mt-4 text-sm text-red-700">Falta la solicitud de acceso. Abre primero el recurso protegido para iniciar sesión.</p>}
    </section>
  </main>
}
