import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, api, type ApiKey, type Domain, type ManagedUser, type Session, type UrlRule } from './api'

type View = 'overview' | 'domains' | 'rules' | 'access' | 'zonal-login'
type Result = { tone: 'error' | 'success' | 'info'; text: string }

const views: { id: View; label: string; eyebrow: string }[] = [
  { id: 'overview', label: 'Resumen', eyebrow: 'Vista general' },
  { id: 'domains', label: 'Dominios', eyebrow: 'Propiedad y DNS' },
  { id: 'rules', label: 'Reglas de caché', eyebrow: 'URLs y políticas' },
  { id: 'access', label: 'Accesos', eyebrow: 'Usuarios y claves' },
  { id: 'zonal-login', label: 'Acceso a caché', eyebrow: 'Inicio de sesión zonal' },
]

const policies: UrlRule['replacementPolicy'][] = ['LRU', 'LFU', 'FIFO', 'MRU', 'Random']

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-2 text-sm font-medium text-slate-800"><span>{label}</span>{children}{hint && <span className="text-xs font-normal text-slate-500">{hint}</span>}</label>
}

function Notice({ result }: { result: Result | null }) {
  if (!result) return null
  const styles = {
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-amber-200 bg-amber-50 text-amber-900',
  }
  return <p role={result.tone === 'error' ? 'alert' : 'status'} className={`break-words rounded-xl border px-4 py-3 text-sm ${styles[result.tone]}`}>{result.text}</p>
}

function Status({ children, online = false }: { children: ReactNode; online?: boolean }) {
  return <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${online ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}><span aria-hidden="true" className={`size-1.5 rounded-full ${online ? 'bg-emerald-600' : 'bg-amber-500'}`} />{children}</span>
}

function Button({ children, secondary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button {...props} className={`inline-flex min-h-10 items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50' : 'bg-indigo-600 text-white hover:bg-indigo-700'} ${props.className ?? ''}`}>{children}</button>
}

function Panel({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold tracking-tight text-slate-950">{title}</h2>{description && <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}</div>{action}</div>{children}</section>
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="mb-7"><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-700">{eyebrow}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{description}</p></div>
}

export default function App() {
  const [view, setView] = useState<View>('overview')
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [apiAvailable, setApiAvailable] = useState(false)
  const [domains, setDomains] = useState<Domain[]>([])
  const [domainsLoading, setDomainsLoading] = useState(false)
  const [domainError, setDomainError] = useState('')
  const [headerError, setHeaderError] = useState<Result | null>(null)
  const [activeDomainId, setActiveDomainId] = useState('')
  const currentView = views.find((item) => item.id === view) ?? views[0]

  const refreshDomains = useCallback(async () => {
    setDomainsLoading(true)
    setDomainError('')
    try {
      const items = await api.domains()
      setDomains(items)
      setApiAvailable(true)
      setActiveDomainId((current) => items.some((domain) => domain.id === current) ? current : items[0]?.id ?? '')
    } catch (error) {
      setDomainError(error instanceof Error ? error.message : 'No se pudieron cargar los dominios.')
    } finally {
      setDomainsLoading(false)
    }
  }, [])

  useEffect(() => {
    let live = true
    api.session().then((value) => {
      if (live) { setSession(value); setApiAvailable(true) }
    }).catch((error: unknown) => {
      if (live) {
        setSession(null)
        setApiAvailable(error instanceof ApiError && error.status !== undefined)
      }
    }).finally(() => { if (live) setSessionLoading(false) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (session) void Promise.resolve().then(refreshDomains)
  }, [session, refreshDomains])

  async function logout() {
    try {
      await api.logout()
      setHeaderError(null)
      setSession(null)
      setView('overview')
    } catch (error) {
      setHeaderError({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudo cerrar la sesión.' })
    }
  }

  const content = (() => {
    switch (view) {
      case 'domains': return <DomainsPage domains={domains} loading={domainsLoading} error={domainError} session={session} onRefresh={refreshDomains} />
      case 'rules': return <RulesPage domains={domains} rulesEnabled={Boolean(session)} activeDomainId={activeDomainId} onDomainChange={setActiveDomainId} />
      case 'access': return <AccessPage domains={domains} signedIn={Boolean(session)} activeDomainId={activeDomainId} />
      case 'zonal-login': return <AuthPage session={session} onAuthenticated={(value) => { setSession(value); setApiAvailable(true) }} zonal />
      default: return <OverviewPage session={session} apiAvailable={apiAvailable} domains={domains} loading={sessionLoading} onNavigate={setView} />
    }
  })()

  return <div className="min-h-svh bg-[#f5f7fb] text-slate-900">
    <aside className="border-b border-slate-200 bg-white lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col lg:border-b-0 lg:border-r">
      <div className="flex items-center gap-3 px-5 py-5 lg:px-6 lg:py-7">
        <span className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-xs font-bold tracking-wide text-white">P2</span>
        <div><p className="text-sm font-bold tracking-tight">Proyecto 2</p><p className="text-xs text-slate-500">Redes · IC7602</p></div>
      </div>
      <nav aria-label="Navegación principal" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:px-3 lg:py-2">
        {views.map((item) => <button key={item.id} type="button" onClick={() => setView(item.id)} aria-current={view === item.id ? 'page' : undefined} className={`shrink-0 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-600 lg:w-full ${view === item.id ? 'bg-indigo-50 text-indigo-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950'}`}><span className="block">{item.label}</span><span className={`hidden text-xs font-normal lg:block ${view === item.id ? 'text-indigo-600' : 'text-slate-400'}`}>{item.eyebrow}</span></button>)}
      </nav>
      <div className="hidden border-t border-slate-100 p-5 lg:block">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Estado de integración</p>
        <div className="mt-3 flex items-center gap-2"><span className={`size-2 rounded-full ${apiAvailable ? 'bg-emerald-500' : 'bg-amber-500'}`} /><span className="text-sm text-slate-600">{apiAvailable ? 'API conectada' : 'Node API pendiente'}</span></div>
        <p className="mt-2 text-xs leading-5 text-slate-400">La caché zonal y el traspaso de sesión siguen pendientes.</p>
      </div>
    </aside>

    <div className="lg:pl-64">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/80 px-5 sm:px-8">
        <div className="min-w-0"><p className="truncate text-xs text-slate-400">Consola / <span className="text-slate-600">{currentView.label}</span></p></div>
        <div className="flex items-center gap-3">{session ? <><span className="hidden max-w-48 truncate text-sm text-slate-600 sm:inline">{session.user.email}</span><Button type="button" secondary onClick={logout}>Cerrar sesión</Button></> : <Button type="button" onClick={() => setView('zonal-login')}>Iniciar sesión</Button>}</div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-7 sm:px-8 sm:py-10">
        <div className="mb-5"><Notice result={headerError} /></div>
        {content}
        <footer className="mt-12 border-t border-slate-200 pt-5 text-xs text-slate-400">Tecnológico de Costa Rica <span className="px-1">·</span> IC7602 <span className="px-1">·</span> Proyecto 2</footer>
      </main>
    </div>
    <Analytics />
    <SpeedInsights />
  </div>
}

function OverviewPage({ session, apiAvailable, domains, loading, onNavigate }: { session: Session | null; apiAvailable: boolean; domains: Domain[]; loading: boolean; onNavigate: (view: View) => void }) {
  return <>
    <PageHeading eyebrow="Panel de control" title="Proxy y caché zonal" description="Administra dominios, políticas de caché y mecanismos de acceso desde un solo lugar." />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-indigo-100 bg-indigo-50 px-5 py-4">
      <div><p className="text-sm font-semibold text-indigo-950">{session ? 'Sesión iniciada' : 'La consola está lista para conectarse'}</p><p className="mt-1 text-sm text-indigo-800">{session ? `Cuenta: ${session.user.email}` : 'Los datos de cuenta y administración se cargarán desde la Node API; no se muestran datos de ejemplo.'}</p></div>
      <Status online={apiAvailable}>{apiAvailable ? 'API conectada' : 'Integración pendiente'}</Status>
    </div>
    <div className="grid gap-4 sm:grid-cols-3">
      <Metric label="Dominios" value={loading ? '…' : session ? String(domains.length) : '—'} detail={session ? 'Registrados en la cuenta' : 'Inicia sesión para consultar'} />
      <Metric label="Verificados" value={session ? String(domains.filter((domain) => domain.verified).length) : '—'} detail="Propiedad confirmada por TXT" />
      <Metric label="Reglas de caché" value="—" detail="Se consultan desde la API" />
    </div>
    <div className="mt-6 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
      <Panel title="Requisitos de interfaz" description="Funciones previstas según la especificación del Proyecto 2.">
        <div className="divide-y divide-slate-100">
          {[
            ['Dominios', 'Registro, verificación TXT y eliminación', 'domains'],
            ['Reglas URL', 'Wildcards, tamaño, TTL y reemplazo', 'rules'],
            ['Control de acceso', 'API keys y usuarios por URL', 'access'],
            ['Autenticación zonal', 'Formulario y sesión; traspaso pendiente', 'zonal-login'],
          ].map(([title, text, target]) => <button key={target} onClick={() => onNavigate(target as View)} className="flex w-full flex-wrap items-center justify-between gap-3 py-4 text-left first:pt-0 last:pb-0"><span><span className="block text-sm font-semibold text-slate-800">{title}</span><span className="mt-1 block text-xs text-slate-500">{text}</span></span><span className="text-xs font-semibold text-indigo-700">Abrir →</span></button>)}
        </div>
      </Panel>
      <Panel title="Servicios requeridos" description="El estado refleja los límites de integración conocidos.">
        <div className="space-y-4">
          <IntegrationRow name="Node REST API" state={apiAvailable ? 'Conectada' : 'Pendiente'} online={apiAvailable} note="Cuenta, dominios, reglas y acceso" />
          <IntegrationRow name="Firebase / Firestore" state="Pendiente" note="Persistencia de datos y configuración" />
          <IntegrationRow name="Caché zonal" state="Pendiente" note="Servicio y traspaso de sesión" />
          <IntegrationRow name="DNS Interceptor" state="Pendiente" note="Resolución geográfica hacia zonas" />
          <IntegrationRow name="REST API Java + Apache" state="Pendiente" note="Objetivos de pruebas de extremo a extremo" />
        </div>
      </Panel>
    </div>
  </>
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-400">{detail}</p></div>
}

function IntegrationRow({ name, state, note, online = false }: { name: string; state: string; note: string; online?: boolean }) {
  return <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-800">{name}</p><p className="mt-1 text-xs leading-5 text-slate-500">{note}</p></div><Status online={online}>{state}</Status></div>
}

function AuthPage({ session, onAuthenticated, zonal = false }: { session: Session | null; onAuthenticated: (session: Session) => void; zonal?: boolean }) {
  const [registering, setRegistering] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setResult(null)
    try {
      const value = registering ? await api.register(email.trim(), password) : await api.login(email.trim(), password)
      onAuthenticated(value)
      setResult({ tone: 'success', text: registering ? 'La cuenta fue creada por la API.' : 'La sesión fue confirmada por la API.' })
    } catch (error) {
      setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No fue posible iniciar sesión.' })
    } finally { setBusy(false) }
  }

  return <div className="mx-auto max-w-3xl">
    <PageHeading eyebrow={registering ? 'Cuenta' : zonal ? 'Acceso de caché zonal' : 'Cuenta'} title={registering ? 'Crear cuenta' : zonal ? 'Autenticación de recursos' : session ? 'Sesión de cuenta' : 'Iniciar sesión'} description={registering ? 'Crea una cuenta para administrar dominios y reglas.' : zonal ? 'Formulario requerido para autenticar solicitudes protegidas. La entrega de la sesión a la caché aún no tiene un protocolo acordado.' : 'La sesión se administra mediante una cookie HttpOnly emitida por la Node API.'} />
    {zonal && !registering && <div className="mb-5"><Status>Traspaso de sesión a caché pendiente</Status></div>}
    <Panel title={session ? 'Cuenta activa' : registering ? 'Registro de usuario' : 'Acceso seguro'} description={session ? session.user.email : 'El servidor valida las credenciales y establece la cookie de sesión.'}>
      {session ? <div className="space-y-4"><p className="text-sm text-slate-600">El formulario no simula autenticación: la cuenta visible corresponde a una respuesta confirmada por la API. Usa el botón «Cerrar sesión» del encabezado para terminar la sesión.</p></div> : <form className="grid gap-5" onSubmit={submit}>
        <Notice result={result} />
        <Field label="Correo electrónico"><input className="control" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
        <Field label="Contraseña" hint="La API debe aplicar su política de seguridad y nunca devolver la contraseña."><input className="control" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy}>{busy ? 'Enviando…' : registering ? 'Crear cuenta' : 'Iniciar sesión'}</Button><Button type="button" secondary onClick={() => { setRegistering(!registering); setResult(null) }}>{registering ? 'Ya tengo una cuenta' : 'Crear una cuenta'}</Button></div>
      </form>}
      <div className="mt-5 border-t border-slate-100 pt-4"><p className="text-xs leading-5 text-slate-500">Node API: registro, inicio/cierre de sesión y consulta de sesión. Cookie HttpOnly y configuración CORS pendientes del servicio.</p></div>
    </Panel>
  </div>
}

function DomainsPage({ domains, loading, error, session, onRefresh }: { domains: Domain[]; loading: boolean; error: string; session: Session | null; onRefresh: () => Promise<void> }) {
  const [hostname, setHostname] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [challenge, setChallenge] = useState<Domain | null>(null)

  async function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setResult(null); setChallenge(null)
    try {
      const domain = await api.createDomain(hostname.trim().toLowerCase())
      setChallenge(domain); setHostname('')
      setResult(domain.verification ? { tone: 'info', text: 'La API creó la solicitud. Publica el registro TXT indicado y solicita la verificación.' } : { tone: 'info', text: 'La API aceptó la solicitud, pero todavía no entregó el registro TXT requerido para verificar el dominio.' })
      await onRefresh()
    } catch (cause) { setResult({ tone: 'error', text: cause instanceof Error ? cause.message : 'No se pudo agregar el dominio.' }) }
    finally { setBusy(false) }
  }

  async function verify(domain: Domain) {
    setBusy(true); setResult(null)
    try {
      const response = await api.verifyDomain(domain.id)
      if (!response.verified) setResult({ tone: 'info', text: 'La API aún no confirma el registro TXT. Revisa DNS y vuelve a intentar.' })
      else setResult({ tone: 'success', text: `${domain.hostname} fue verificado por la API.` })
      await onRefresh()
    } catch (cause) { setResult({ tone: 'error', text: cause instanceof Error ? cause.message : 'No se pudo verificar el dominio.' }) }
    finally { setBusy(false) }
  }

  async function remove(domain: Domain) {
    if (!window.confirm(`¿Eliminar ${domain.hostname} y sus reglas asociadas?`)) return
    setBusy(true); setResult(null)
    try { await api.deleteDomain(domain.id); setResult({ tone: 'success', text: 'La API confirmó la eliminación.' }); await onRefresh() }
    catch (cause) { setResult({ tone: 'error', text: cause instanceof Error ? cause.message : 'No se pudo eliminar el dominio.' }) }
    finally { setBusy(false) }
  }

  return <>
    <PageHeading eyebrow="Propiedad y DNS" title="Dominios" description="Registra dominios y demuestra su propiedad mediante un registro TXT antes de configurar reglas." />
    <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
      <Panel title="Agregar un dominio" description="La API debe proporcionar el nombre y valor TXT para verificar la propiedad.">
        {session ? <form onSubmit={addDomain} className="grid gap-4"><Notice result={result} /><Field label="Nombre de dominio" hint="Ejemplo: ejemplo.com"><input className="control" type="text" autoComplete="url" required pattern="(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}" value={hostname} onChange={(event) => setHostname(event.target.value)} /></Field><Button type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Solicitar verificación'}</Button></form> : <PendingLogin />}
        {challenge?.verification && <div className="mt-5 rounded-xl border border-indigo-100 bg-indigo-50 p-4"><p className="text-sm font-semibold text-indigo-950">Registro TXT requerido</p><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-[auto_1fr]"><dt className="text-indigo-700">Nombre</dt><dd className="break-all font-mono text-xs text-slate-800">{challenge.verification.name}</dd><dt className="text-indigo-700">Valor</dt><dd className="break-all font-mono text-xs text-slate-800">{challenge.verification.value}</dd></dl><Button className="mt-4" type="button" disabled={busy} onClick={() => void verify(challenge)}>Verificar TXT</Button></div>}
      </Panel>
      <Panel title="Dominios registrados" description="El estado se obtiene de la API; no se precargan dominios de ejemplo." action={<Button type="button" secondary onClick={() => void onRefresh()} disabled={!session || loading}>Actualizar</Button>}>
        <Notice result={error ? { tone: 'error', text: error } : null} />
        {!session ? <PendingLogin /> : loading ? <p className="py-8 text-center text-sm text-slate-500">Cargando dominios…</p> : domains.length === 0 ? <Empty text="La API no devolvió dominios registrados." /> : <div className="divide-y divide-slate-100">{domains.map((domain) => <div key={domain.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"><div className="min-w-0"><p className="break-all font-semibold text-slate-900">{domain.hostname}</p><p className="mt-1 text-xs text-slate-500">{domain.verified ? 'Propiedad verificada' : 'Esperando verificación TXT'}</p></div><div className="flex items-center gap-2"><Status online={domain.verified}>{domain.verified ? 'Verificado' : 'Pendiente'}</Status>{!domain.verified && <Button type="button" secondary disabled={busy} onClick={() => void verify(domain)}>Verificar</Button>}<Button type="button" secondary disabled={busy} onClick={() => void remove(domain)}>Eliminar</Button></div></div>)}</div>}
        {result && !challenge?.verification && <div className="mt-4"><Notice result={result} /></div>}
      </Panel>
    </div>
  </>
}

function PendingLogin() {
  return <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">Inicia sesión para usar estas funciones. La cuenta y los datos se consultan en la Node API.</p>
}

function Empty({ text }: { text: string }) { return <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">{text}</p> }

function RulesPage({ domains, rulesEnabled, activeDomainId, onDomainChange }: { domains: Domain[]; rulesEnabled: boolean; activeDomainId: string; onDomainChange: (id: string) => void }) {
  type DraftFileType = { extension: string; ttlSeconds: string }
  const [rules, setRules] = useState<UrlRule[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [pattern, setPattern] = useState('')
  const [cacheSize, setCacheSize] = useState('')
  const [fileTypes, setFileTypes] = useState<DraftFileType[]>([{ extension: '', ttlSeconds: '' }])
  const [policy, setPolicy] = useState<UrlRule['replacementPolicy'] | ''>('')
  const [authMode, setAuthMode] = useState<UrlRule['authMode'] | ''>('')
  const [editingRule, setEditingRule] = useState<UrlRule | null>(null)
  const selectedDomain = domains.find((domain) => domain.id === activeDomainId)

  const loadRules = useCallback(async () => {
    if (!activeDomainId || !rulesEnabled) { setRules([]); return }
    setLoading(true)
    try { setRules(await api.rules(activeDomainId)) }
    catch (error) { setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudieron cargar las reglas.' }) }
    finally { setLoading(false) }
  }, [activeDomainId, rulesEnabled])

  useEffect(() => { void Promise.resolve().then(loadRules) }, [loadRules])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setResult(null)
    try {
      if (!policy || !authMode) throw new Error('Selecciona una política y un mecanismo de autenticación.')
      const value = { pattern: pattern.trim(), cacheSizeMb: Number(cacheSize), fileTypes: fileTypes.map((item) => ({ extension: item.extension.trim().toLowerCase(), ttlSeconds: Number(item.ttlSeconds) })), replacementPolicy: policy, authMode }
      if (editingRule) await api.updateRule(activeDomainId, editingRule.id, value)
      else await api.createRule(activeDomainId, value)
      await loadRules()
      setResult({ tone: 'success', text: editingRule ? 'La API confirmó la actualización de la regla.' : 'La API confirmó la creación de la regla.' })
      setPattern(''); setCacheSize(''); setFileTypes([{ extension: '', ttlSeconds: '' }]); setPolicy(''); setAuthMode(''); setEditingRule(null)
    } catch (error) { setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudo guardar la regla.' }) }
    finally { setBusy(false) }
  }

  async function remove(rule: UrlRule) {
    if (!window.confirm(`¿Eliminar la regla ${rule.pattern}?`)) return
    setBusy(true); setResult(null)
    try { await api.deleteRule(activeDomainId, rule.id); await loadRules(); setResult({ tone: 'success', text: 'La API confirmó la eliminación.' }) }
    catch (error) { setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudo eliminar la regla.' }) }
    finally { setBusy(false) }
  }

  return <>
    <PageHeading eyebrow="URLs y políticas" title="Reglas de caché" description="Asocia patrones de URL, incluso wildcards, con límites de caché, tipos de archivo, TTL y política de reemplazo." />
    <div className="mb-5 max-w-sm"><Field label="Dominio"><select className="control" value={activeDomainId} onChange={(event) => { onDomainChange(event.target.value); setResult(null); setEditingRule(null); setPattern(''); setCacheSize(''); setFileTypes([{ extension: '', ttlSeconds: '' }]); setPolicy(''); setAuthMode('') }} disabled={!rulesEnabled || domains.length === 0}><option value="">Selecciona un dominio</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}{domain.verified ? '' : ' · sin verificar'}</option>)}</select></Field></div>
    {!rulesEnabled ? <PendingLogin /> : !selectedDomain ? <Empty text="Registra un dominio para comenzar a definir reglas." /> : <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
      <Panel title="Nueva regla" description="El patrón se interpreta dentro del dominio seleccionado.">
        <form onSubmit={submit} className="grid gap-4">
          <Notice result={result} />
          <Field label="Patrón URL" hint="Ejemplo: /assets/* o *.ejemplo.com/ruta/*"><input className="control font-mono" required value={pattern} onChange={(event) => setPattern(event.target.value)} /></Field>
          <Field label="Tamaño máximo de caché (MB)"><input className="control" type="number" min="1" step="1" required value={cacheSize} onChange={(event) => setCacheSize(event.target.value)} /></Field>
          <fieldset className="grid gap-3"><legend className="text-sm font-medium text-slate-800">Tipos de archivo y TTL</legend>{fileTypes.map((item, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"><Field label={`Extensión ${index + 1}`}><input aria-label={`Extensión ${index + 1}`} className="control" placeholder=".html" pattern="\.[a-zA-Z0-9]{1,12}" required value={item.extension} onChange={(event) => setFileTypes((current) => current.map((file, i) => i === index ? { ...file, extension: event.target.value } : file))} /></Field><Field label="TTL (segundos)"><input aria-label={`TTL ${index + 1} en segundos`} className="control" type="number" min="1" step="1" required value={item.ttlSeconds} onChange={(event) => setFileTypes((current) => current.map((file, i) => i === index ? { ...file, ttlSeconds: event.target.value } : file))} /></Field><Button type="button" secondary aria-label={`Eliminar tipo ${index + 1}`} disabled={fileTypes.length === 1} onClick={() => setFileTypes((current) => current.filter((_, i) => i !== index))}>×</Button></div>)}<Button type="button" secondary onClick={() => setFileTypes((current) => [...current, { extension: '', ttlSeconds: '' }])}>Agregar tipo de archivo</Button></fieldset>
          <Field label="Política de reemplazo"><select className="control" required value={policy} onChange={(event) => setPolicy(event.target.value as UrlRule['replacementPolicy'] | '')}><option value="">Selecciona una política</option>{policies.map((item) => <option key={item}>{item}</option>)}</select></Field>
          <fieldset className="grid gap-2"><legend className="text-sm font-medium text-slate-800">Autenticación de la URL</legend><label className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" name="auth-mode" required checked={authMode === 'api-key'} onChange={() => setAuthMode('api-key')} />Clave API mediante <code className="rounded bg-slate-100 px-1">x-api-key</code></label><label className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" name="auth-mode" required checked={authMode === 'credentials'} onChange={() => setAuthMode('credentials')} />Usuario y contraseña</label></fieldset>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !selectedDomain.verified}>{busy ? 'Guardando…' : editingRule ? 'Guardar cambios' : 'Crear regla'}</Button>{editingRule && <Button type="button" secondary onClick={() => { setEditingRule(null); setPattern(''); setCacheSize(''); setFileTypes([{ extension: '', ttlSeconds: '' }]); setPolicy(''); setAuthMode('') }}>Cancelar edición</Button>}</div>
          {!selectedDomain.verified && <p className="text-xs text-amber-800">Verifica el dominio antes de crear reglas.</p>}
        </form>
      </Panel>
      <Panel title="Reglas registradas" description={`Configuración asociada a ${selectedDomain.hostname}.`} action={<Button type="button" secondary onClick={() => void loadRules()} disabled={loading}>Actualizar</Button>}>
        {loading ? <p className="py-8 text-center text-sm text-slate-500">Cargando reglas…</p> : rules.length === 0 ? <Empty text="La API no devolvió reglas para este dominio." /> : <div className="space-y-3">{rules.map((rule) => <div key={rule.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-all font-mono text-sm font-semibold text-slate-900">{rule.pattern}</p><p className="mt-2 text-xs leading-5 text-slate-500">{rule.cacheSizeMb} MB · {rule.replacementPolicy} · {rule.authMode === 'api-key' ? 'x-api-key' : 'Usuario y contraseña'}</p><p className="mt-1 text-xs text-slate-500">{rule.fileTypes.map((item) => `${item.extension}: ${item.ttlSeconds}s`).join(' · ')}</p></div><div className="flex gap-2"><Button type="button" secondary disabled={busy} onClick={() => { setEditingRule(rule); setPattern(rule.pattern); setCacheSize(String(rule.cacheSizeMb)); setFileTypes(rule.fileTypes.map((item) => ({ extension: item.extension, ttlSeconds: String(item.ttlSeconds) }))); setPolicy(rule.replacementPolicy); setAuthMode(rule.authMode) }}>Editar</Button><Button type="button" secondary disabled={busy} onClick={() => void remove(rule)}>Eliminar</Button></div></div></div>)}</div>}
      </Panel>
    </div>}
  </>
}

function AccessPage({ domains, signedIn, activeDomainId }: { domains: Domain[]; signedIn: boolean; activeDomainId: string }) {
  const [domainId, setDomainId] = useState(activeDomainId)
  const [rules, setRules] = useState<UrlRule[]>([])
  const [ruleId, setRuleId] = useState('')
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [keyLabel, setKeyLabel] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const selectedRule = rules.find((rule) => rule.id === ruleId)

  useEffect(() => {
    let live = true
    if (!signedIn || !domainId) return
    api.rules(domainId).then((items) => { if (live) { setRules(items); setRuleId((current) => items.some((rule) => rule.id === current) ? current : items[0]?.id ?? '') } }).catch((error: unknown) => { if (live) setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudieron cargar las reglas.' }) })
    return () => { live = false }
  }, [signedIn, domainId])
  useEffect(() => {
    let live = true
    if (!selectedRule || !domainId) return
    if (selectedRule.authMode === 'credentials') api.users(domainId, selectedRule.id).then((items) => { if (live) setUsers(items) }).catch((error: unknown) => { if (live) setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudieron cargar los usuarios.' }) })
    else api.keys(domainId, selectedRule.id).then((items) => { if (live) setKeys(items) }).catch((error: unknown) => { if (live) setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudieron cargar las claves.' }) })
    return () => { live = false }
  }, [domainId, selectedRule])

  async function mutate(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true); setResult(null)
    try {
      await action()
      setResult({ tone: 'success', text: success })
    }
    catch (error) { setResult({ tone: 'error', text: error instanceof Error ? error.message : 'La API no confirmó el cambio.' }); setBusy(false); return false }
    try {
      if (selectedRule?.authMode === 'credentials') setUsers(await api.users(domainId, ruleId))
      else if (selectedRule?.authMode === 'api-key') setKeys(await api.keys(domainId, ruleId))
    } catch {
      setResult({ tone: 'info', text: `${success} No se pudo actualizar la lista; vuelve a cargarla.` })
    } finally { setBusy(false) }
    return true
  }

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!domainId || !ruleId) return
    if (await mutate(() => api.createUser(domainId, ruleId, username.trim(), password), 'La API confirmó la creación del usuario.')) { setUsername(''); setPassword('') }
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!domainId || !ruleId) return
    setBusy(true); setResult(null)
    try { const key = await api.createKey(domainId, ruleId, keyLabel.trim()); const { secret, ...metadata } = key; setKeys((current) => [...current, metadata]); setResult({ tone: 'success', text: secret ? `Clave creada. Cópiala ahora: ${secret}` : 'La API confirmó la creación de la clave.' }); setKeyLabel('') }
    catch (error) { setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No se pudo crear la clave.' }) }
    finally { setBusy(false) }
  }

  return <>
    <PageHeading eyebrow="Usuarios y claves" title="Accesos por URL" description="Administra las credenciales que protegen cada regla. Las claves secretas solo se muestran si la API las entrega al crearlas." />
    {!signedIn ? <PendingLogin /> : <>
      <div className="mb-5 grid gap-4 sm:grid-cols-2"><Field label="Dominio"><select className="control" value={domainId} onChange={(event) => { setDomainId(event.target.value); setRules([]); setRuleId(''); setUsers([]); setKeys([]) }}><option value="">Selecciona un dominio</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</select></Field><Field label="Regla URL"><select className="control" value={ruleId} onChange={(event) => { setRuleId(event.target.value); setUsers([]); setKeys([]) }}><option value="">Selecciona una regla</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.pattern}</option>)}</select></Field></div>
      {!selectedRule ? <Empty text="Selecciona una regla existente para configurar su autenticación." /> : <div className="grid gap-5 xl:grid-cols-2"><Panel title={selectedRule.authMode === 'credentials' ? 'Usuarios y contraseñas' : 'Claves API'} description={selectedRule.authMode === 'credentials' ? 'Las contraseñas se envían solo a la API para crear o actualizar credenciales.' : 'Las claves se enviarán a las cachés zonales mediante el encabezado x-api-key.'}><Notice result={result} />{selectedRule.authMode === 'credentials' ? <><form onSubmit={addUser} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Field label="Usuario"><input className="control" required value={username} onChange={(event) => setUsername(event.target.value)} /></Field><Field label="Contraseña"><input className="control" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></Field><div className="self-end"><Button type="submit" disabled={busy}>Agregar</Button></div></form><div className="mt-5 divide-y divide-slate-100">{users.length ? users.map((user) => <UserRow key={user.id} user={user} domainId={domainId} ruleId={ruleId} busy={busy} onMutate={mutate} />) : <Empty text="La API no devolvió usuarios para esta regla." />}</div></> : <><form onSubmit={createKey} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><Field label="Nombre de referencia"><input className="control" required value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)} /></Field><div className="self-end"><Button type="submit" disabled={busy}>Crear clave</Button></div></form><div className="mt-5 divide-y divide-slate-100">{keys.length ? keys.map((key) => <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-semibold text-slate-800">{key.label}</p><p className="font-mono text-xs text-slate-500">{key.prefix}••••••</p></div><Button type="button" secondary disabled={busy} onClick={() => void mutate(() => api.deleteKey(domainId, ruleId, key.id), 'La API confirmó la eliminación de la clave.')}>Eliminar</Button></div>) : <Empty text="La API no devolvió claves para esta regla." />}</div></>}</Panel><Panel title="Contrato pendiente" description="El frontend no habilita una credencial hasta que la API la confirme."><div className="space-y-4 text-sm leading-6 text-slate-600"><p>Las credenciales se configuran por regla URL. La caché zonal debe validar la sesión o clave recibida para cada recurso protegido.</p><IntegrationRow name="Validación x-api-key en caché" state="Pendiente" note="La caché debe verificar las claves contra el servicio de configuración." /><IntegrationRow name="Usuarios en caché zonal" state="Pendiente" note="La autenticación y el traspaso de sesión aún requieren contrato de servicio." /></div></Panel></div>}
    </>}
  </>
}

function UserRow({ user, domainId, ruleId, busy, onMutate }: { user: ManagedUser; domainId: string; ruleId: string; busy: boolean; onMutate: (action: () => Promise<unknown>, success: string) => Promise<boolean> }) {
  const [username, setUsername] = useState(user.username)
  const [password, setPassword] = useState('')
  const userChanged = username.trim() !== user.username
  const passwordChanged = password.length > 0
  return <div className="grid gap-3 py-3 sm:grid-cols-[1fr_1.2fr_auto] sm:items-end"><Field label="Usuario"><input className="control" required value={username} onChange={(event) => setUsername(event.target.value)} /></Field><Field label="Nueva contraseña (opcional)"><input className="control" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field><div className="flex gap-2"><Button type="button" secondary disabled={busy || (!userChanged && !passwordChanged)} onClick={() => void onMutate(() => api.updateUser(domainId, ruleId, user.id, { ...(userChanged ? { username: username.trim() } : {}), ...(passwordChanged ? { password } : {}) }), 'La API confirmó la actualización del usuario.').then((succeeded) => { if (succeeded) setPassword('') })}>Guardar</Button><Button type="button" secondary disabled={busy} onClick={() => void onMutate(() => api.deleteUser(domainId, ruleId, user.id), 'La API confirmó la eliminación del usuario.')}>Eliminar</Button></div></div>
}

export default App
