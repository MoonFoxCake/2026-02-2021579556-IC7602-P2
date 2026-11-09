import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, api, type CacheTestResult, type Domain, type UrlRule } from './api'

type Props = { signedIn: boolean; onUnauthorized: () => void }
type Result = CacheTestResult & { id: string; host: string; path: string; time: string }
type Message = { error: boolean; text: string } | null

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 className="text-base font-semibold text-slate-950">{title}</h2><div className="mt-4 grid gap-4">{children}</div></section>
}
function Action({ secondary = false, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button {...props} type="button" className={`inline-flex min-h-10 items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? 'border border-slate-200 bg-white text-slate-800' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>{children}</button>
}

function defaultPath(rule: UrlRule) {
  if (rule.pattern === '/*') return '/index.html'
  if (rule.pattern === '/api/*') return '/api/items.json'
  return rule.pattern.replace(/\*/g, `example.${rule.fileTypes[0]?.ext || 'html'}`)
}

export function CacheTestPage({ signedIn, onUnauthorized }: Props) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [domain, setDomain] = useState('')
  const [rules, setRules] = useState<UrlRule[]>([])
  const [urlId, setUrlId] = useState('')
  const [host, setHost] = useState('')
  const [path, setPath] = useState('/index.html')
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<Message>(null)
  const [results, setResults] = useState<Result[]>([])
  const selected = rules.find((rule) => rule.id === urlId)

  useEffect(() => {
    if (!signedIn) return
    let active = true
    void Promise.all([api.listDomains(), api.cacheTestStatus()]).then(([items, status]) => {
      if (!active) return
      const verified = items.filter((item) => item.verified)
      setDomains(verified); setDomain((current) => verified.some((item) => item.domain === current) ? current : verified[0]?.domain || ''); setEnabled(status.enabled)
    }).catch((error: unknown) => {
      if (!active) return
      if (error instanceof ApiError && error.status === 401) onUnauthorized()
      setMessage({ error: true, text: error instanceof Error ? error.message : 'No se pudo cargar el panel.' })
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [signedIn, onUnauthorized, attempt])

  useEffect(() => {
    if (!domain) return
    let active = true
    void api.listUrls(domain).then((items) => {
      if (!active) return
      setRules(items)
      const first = items[0]
      setUrlId(first?.id || ''); setPath(first ? defaultPath(first) : '/index.html')
      setHost(domain.startsWith('*.') ? `demo.${domain.slice(2)}` : domain)
    }).catch((error: unknown) => {
      if (!active) return
      if (error instanceof ApiError && error.status === 401) onUnauthorized()
      setMessage({ error: true, text: error instanceof Error ? error.message : 'No se pudieron cargar las reglas.' })
    })
    return () => { active = false }
  }, [domain, onUnauthorized, attempt])

  function selectRule(id: string) {
    setUrlId(id); setApiKey(''); setUsername(''); setPassword(''); setResults([]); setMessage(null)
    const rule = rules.find((item) => item.id === id)
    if (rule) setPath(defaultPath(rule))
  }
  function failed(error: unknown) {
    if (error instanceof ApiError && error.status === 401) onUnauthorized()
    setMessage({ error: true, text: error instanceof Error ? error.message : 'No se pudo completar la operación.' })
  }

  async function probe(twice = false) {
    setBusy(true); setMessage(null)
    try {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('La ruta debe empezar con / y pertenecer al host seleccionado.')
      let target = path
      if (twice) {
        const parsed = new URL(path, 'http://cache.local')
        parsed.searchParams.set('cache_probe', crypto.randomUUID())
        target = parsed.pathname + parsed.search
        setPath(target)
      }
      const outcomes: string[] = []
      for (let i = 0; i < (twice ? 2 : 1); i++) {
        const result = await api.testCache({ urlId, host, path: target, ...(selected?.authType === 'apikey' && apiKey ? { apiKey } : {}) })
        setResults((current) => [{ ...result, id: crypto.randomUUID(), host, path: target, time: new Date().toLocaleTimeString() }, ...current].slice(0, 10))
        if (result.requiresLogin) { setMessage({ error: true, text: 'La caché requiere iniciar sesión para este recurso.' }); return }
        if (result.status >= 400) { setMessage({ error: true, text: `El recurso respondió HTTP ${result.status}. Revisa las credenciales, la ruta y el origen.` }); return }
        outcomes.push(`${result.headers['x-cache'] || 'Sin X-Cache'} (HTTP ${result.status})`)
      }
      setMessage({ error: false, text: outcomes.join(' → ') })
    } catch (error) { failed(error) } finally { setBusy(false) }
  }

  async function authenticate(logout = false) {
    setBusy(true); setMessage(null)
    try {
      const input = { urlId, host, path }
      if (logout) {
        await api.logoutCache(input)
        setMessage({ error: false, text: 'Sesión de caché cerrada. Puedes solicitar el recurso otra vez para comprobarlo.' })
      } else {
        const result = await api.loginCache({ ...input, username, password })
        setMessage({ error: !result.authenticated, text: `${result.message} (HTTP ${result.status})` })
      }
    } catch (error) { failed(error) } finally { setBusy(false); setPassword('') }
  }

  if (!signedIn) return <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">Inicia sesión con tu cuenta para probar tus reglas de caché.</p>

  return <div aria-busy={busy || loading} className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
    <div className="grid content-start gap-5"><Card title="Recurso de prueba">
      <p className="text-sm leading-6 text-slate-600">Selecciona una regla y solicita un recurso para ver la respuesta real de la caché. Los cambios de configuración pueden tardar unos segundos.</p>
      {loading && <p role="status">Cargando dominios…</p>}
      {enabled === false && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Este entorno no tiene una caché de prueba disponible.</p>}
      {!loading && domains.length === 0 && !message?.error && <p className="text-sm text-slate-500">Necesitas un dominio verificado y una regla. El entorno local incluye p2.test.</p>}
      <label className="grid gap-2 text-sm font-medium">Dominio<select className="control" disabled={busy || loading} value={domain} onChange={(event) => { setDomain(event.target.value); setRules([]); setUrlId(''); setApiKey(''); setPassword(''); setResults([]); setMessage(null) }}>{domains.map((item) => <option key={item.domain}>{item.domain}</option>)}</select></label>
      <label className="grid gap-2 text-sm font-medium">Regla de caché<select className="control" disabled={busy || !rules.length} value={urlId} onChange={(event) => selectRule(event.target.value)}>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.pattern} · {rule.authType}</option>)}</select></label>
      {!loading && domain && !rules.length && <p className="text-sm text-slate-500">No hay reglas cargadas. Crea una en Reglas de caché o pulsa Actualizar reglas.</p>}
      {selected && <p className="break-all text-xs leading-5 text-slate-500">Origen: {selected.origin}<br />{selected.replacementPolicy} · {selected.fileTypes.map((file) => `${file.ext}: ${file.ttlSeconds}s`).join(', ')}</p>}
      <label className="grid gap-2 text-sm font-medium">Host del recurso<input className="control" value={host} disabled={busy || !selected} onChange={(event) => setHost(event.target.value)} /></label>
      <label className="grid gap-2 text-sm font-medium">Ruta del recurso (GET)<input className="control" value={path} disabled={busy || !selected} maxLength={1800} onChange={(event) => setPath(event.target.value)} placeholder="/index.html" /></label>
      <div className="flex flex-wrap gap-2"><Action disabled={busy || !selected || !enabled} onClick={() => void probe()}>Enviar solicitud</Action><Action secondary disabled={busy || !selected || !enabled} onClick={() => void probe(true)}>Probar MISS → HIT</Action></div>
      <p className="text-xs leading-5 text-slate-500">La prueba doble agrega un identificador nuevo a la URL y repite el mismo GET. Si el recurso es cacheable, verás MISS seguido de HIT. Un archivo no configurado o una respuesta distinta de 200 puede mostrar BYPASS.</p>
      <Action secondary disabled={busy || loading} onClick={() => { setLoading(true); setMessage(null); setResults([]); setAttempt((value) => value + 1) }}>Actualizar reglas</Action>
    </Card>
    <Card title="Autenticación del recurso">
      {!selected ? <p className="text-sm text-slate-500">Selecciona una regla.</p> : selected.authType === 'none' ? <p className="text-sm text-slate-600">Esta regla permite acceso sin credenciales. Puedes cambiar su autenticación en Reglas de caché.</p> : selected.authType === 'apikey' ? <label className="grid gap-2 text-sm font-medium">API key<input className="control" type="password" autoComplete="off" disabled={busy} maxLength={512} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /><span className="text-xs font-normal text-slate-500">Crea una clave en Accesos. Déjala vacía para comprobar el rechazo de una solicitud sin clave.</span></label> : <>
        <p className="text-sm text-slate-600">Usa un usuario de esta regla creado en Accesos. La cuenta de administración es independiente.</p>
        <label className="grid gap-2 text-sm font-medium">Usuario del recurso<input className="control" autoComplete="off" disabled={busy} maxLength={255} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="grid gap-2 text-sm font-medium">Contraseña del recurso<input className="control" type="password" autoComplete="off" disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Action disabled={busy || !enabled || !username || !password} onClick={() => void authenticate()}>Iniciar sesión en caché</Action><Action secondary disabled={busy || !enabled} onClick={() => void authenticate(true)}>Cerrar sesión de caché</Action></div>
      </>}
    </Card>
    {busy && <p role="status" className="text-sm text-indigo-700">Consultando la caché…</p>}
    {message && <p role={message.error ? 'alert' : 'status'} className={`rounded-xl border p-4 text-sm ${message.error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{message.text}</p>}
    </div>
    <Card title="Resultados de la caché">
      {!results.length && <p className="text-sm leading-6 text-slate-500">Envía una solicitud. Aquí aparecerán el estado HTTP, HIT/MISS, tiempo, encabezados y cuerpo de respuesta. Se conservan las últimas 10 solicitudes de esta vista.</p>}
      {results.map((result, index) => {
        const cache = result.headers['x-cache'] || 'Sin X-Cache'
        return <article key={result.id} className="min-w-0 rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-3 py-1 text-xs font-bold ${cache === 'HIT' ? 'bg-emerald-50 text-emerald-800' : cache === 'MISS' ? 'bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>{cache}</span><span className="text-xs text-slate-500">HTTP {result.status} · {result.elapsedMs} ms · {result.time}</span></div>
          <p className="mt-3 break-all font-mono text-xs">GET {result.host}{result.path}</p>
          {result.requiresLogin && <p className="mt-3 text-sm text-amber-900">Autenticación requerida por la caché.</p>}
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">{[['Zona', 'x-zc-zone'], ['Regla aplicada', 'x-zc-rule'], ['Política', 'x-zc-policy'], ['TTL configurado', 'x-zc-ttl']].map(([label, name]) => <div key={name}><dt className="text-slate-500">{label}</dt><dd className="mt-1 break-all font-semibold">{result.headers[name] || '—'}</dd></div>)}</dl>
          <details open={index === 0} className="mt-4"><summary className="cursor-pointer text-sm font-medium">Encabezados y cuerpo</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`).join('\n')}{'\n\n'}{result.body}</pre>{result.truncated && <p className="mt-2 text-xs text-amber-900">Vista limitada a los primeros 64 KiB.</p>}</details>
        </article>
      })}
    </Card>
  </div>
}
