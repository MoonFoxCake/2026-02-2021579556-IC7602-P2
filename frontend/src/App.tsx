import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { ApiError, api, type Session } from './api'
import { AccessPage, DomainsPage, RulesPage } from './ManagementPages'

type View = 'overview' | 'account' | 'domains' | 'rules' | 'access' | 'cache-login'
type NoticeState = { tone: 'error' | 'success' | 'info'; text: string }

const views: { id: View; label: string; detail: string }[] = [
  { id: 'overview', label: 'Resumen', detail: 'Estado de integración' },
  { id: 'account', label: 'Cuenta', detail: 'Registro e inicio de sesión' },
  { id: 'domains', label: 'Dominios', detail: 'Registro TXT' },
  { id: 'rules', label: 'Reglas de caché', detail: 'URLs y políticas' },
  { id: 'access', label: 'Accesos', detail: 'Usuarios y claves por URL' },
  { id: 'cache-login', label: 'Acceso a caché', detail: 'Sesión en caché zonal' },
]

function Button({ children, secondary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button {...props} className={`inline-flex min-h-10 items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50' : 'bg-indigo-600 text-white hover:bg-indigo-700'} ${props.className ?? ''}`}>{children}</button>
}
function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 className="text-base font-semibold tracking-tight text-slate-950">{title}</h2>{description && <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}<div className="mt-5">{children}</div></section>
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="mb-7"><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-700">{eyebrow}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{description}</p></div>
}

function Notice({ value }: { value: NoticeState | null }) {
  if (!value) return null
  const tone = value.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : value.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'
  return <p role={value.tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${tone}`}>{value.text}</p>
}

function Status({ children, ready = false }: { children: ReactNode; ready?: boolean }) {
  return <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${ready ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}><span aria-hidden="true" className={`size-1.5 rounded-full ${ready ? 'bg-emerald-600' : 'bg-amber-500'}`} />{children}</span>
}

export default function App() {
  const [view, setView] = useState<View>('overview')
  const [session, setSession] = useState<Session | null>(null)
  const [apiStatus, setApiStatus] = useState<'checking' | 'available' | 'unavailable'>('checking')
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const currentView = views.find((item) => item.id === view) ?? views[0]

  useEffect(() => {
    let active = true
    void api.health().then((available) => {
      if (active) setApiStatus(available ? 'available' : 'unavailable')
    }).catch(() => {
      if (active) setApiStatus('unavailable')
    })
    return () => { active = false }
  }, [])

  function logout() {
    api.logout()
    setSession(null)
    setView('overview')
    setNotice({ tone: 'info', text: 'La sesión local se cerró. El token se elimina de memoria.' })
  }

  const onUnauthorized = useCallback(() => {
    api.logout()
    setSession(null)
    setNotice({ tone: 'error', text: 'La sesión venció o dejó de ser válida. Inicia sesión de nuevo.' })
  }, [])

  const content = (() => {
    switch (view) {
      case 'account': return <AccountPage session={session} onAuthenticated={(value) => { setSession(value); setApiStatus('available'); setNotice(null) }} onApiResponded={() => setApiStatus('available')} />
      case 'domains': return <><PageHeading eyebrow="Propiedad y DNS" title="Dominios" description="Registra tus dominios, publica el reto TXT y confirma que el dominio te pertenece." /><DomainsPage key={session?.user.id ?? 'signed-out'} signedIn={!!session} onUnauthorized={onUnauthorized} /></>
      case 'rules': return <><PageHeading eyebrow="URLs y políticas" title="Reglas de caché" description="Define patrones, origen, tamaño de caché, TTL por tipo de archivo y política de reemplazo." /><RulesPage key={session?.user.id ?? 'signed-out'} signedIn={!!session} onUnauthorized={onUnauthorized} /></>
      case 'access': return <><PageHeading eyebrow="Usuarios y claves" title="Accesos por URL" description="Crea y revoca API keys, y administra las cuentas que protegen cada URL." /><AccessPage key={session?.user.id ?? 'signed-out'} signedIn={!!session} onUnauthorized={onUnauthorized} /></>
      case 'cache-login': return <PendingPage />
      default: return <OverviewPage session={session} apiStatus={apiStatus} onNavigate={setView} />
    }
  })()

  return <div className="min-h-svh bg-[#f5f7fb] text-slate-900">
    <aside className="border-b border-slate-200 bg-white lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col lg:border-b-0 lg:border-r">
      <div className="flex items-center gap-3 px-5 py-5 lg:px-6 lg:py-7"><span className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-xs font-bold tracking-wide text-white">P2</span><div><p className="text-sm font-bold tracking-tight">Proyecto 2</p><p className="text-xs text-slate-500">Redes · IC7602</p></div></div>
      <nav aria-label="Navegación principal" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:px-3 lg:py-2">
        {views.map((item) => <button key={item.id} type="button" onClick={() => { setView(item.id); setNotice(null) }} aria-current={view === item.id ? 'page' : undefined} className={`shrink-0 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-600 lg:w-full ${view === item.id ? 'bg-indigo-50 text-indigo-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950'}`}><span className="block">{item.label}</span><span className={`hidden text-xs font-normal lg:block ${view === item.id ? 'text-indigo-600' : 'text-slate-400'}`}>{item.detail}</span></button>)}
      </nav>
      <div className="hidden border-t border-slate-100 p-5 lg:block"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">Node API</p><div className="mt-3"><Status ready={apiStatus === 'available'}>{apiStatus === 'checking' ? 'Comprobando API…' : apiStatus === 'available' ? 'API disponible' : 'API no disponible'}</Status></div><p className="mt-2 text-xs leading-5 text-slate-400">Cuentas, dominios, URLs y credenciales usan rutas de administración. El acceso de usuario a la caché sigue pendiente.</p></div>
    </aside>

    <div className="lg:pl-64">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/80 px-5 sm:px-8"><p className="truncate text-xs text-slate-400">Consola / <span className="text-slate-600">{currentView.label}</span></p><div className="flex items-center gap-3">{session ? <><span className="hidden max-w-48 truncate text-sm text-slate-600 sm:inline">{session.user.email}</span><Button type="button" secondary onClick={logout}>Cerrar sesión</Button></> : <Button type="button" onClick={() => { setView('account'); setNotice(null) }}>Iniciar sesión</Button>}</div></header>
      <main className="mx-auto max-w-7xl px-4 py-7 sm:px-8 sm:py-10"><div className="mb-5"><Notice value={notice} /></div>{content}<footer className="mt-12 border-t border-slate-200 pt-5 text-xs text-slate-400">Tecnológico de Costa Rica <span className="px-1">·</span> IC7602 <span className="px-1">·</span> Proyecto 2</footer></main>
    </div>
    <Analytics /><SpeedInsights />
  </div>
}

function OverviewPage({ session, apiStatus, onNavigate }: { session: Session | null; apiStatus: 'checking' | 'available' | 'unavailable'; onNavigate: (view: View) => void }) {
  return <>
    <PageHeading eyebrow="Panel de control" title="Proxy y caché zonal" description="Consulta el estado de la cuenta y revisa qué integraciones ya están disponibles para la consola." />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-indigo-100 bg-indigo-50 px-5 py-4"><div><p className="text-sm font-semibold text-indigo-950">{session ? 'Sesión iniciada' : 'Consola lista'}</p><p className="mt-1 text-sm text-indigo-800">{session ? session.user.email : 'El inicio de sesión usa JWT temporal mantenido en memoria.'}</p></div><Status ready={apiStatus === 'available'}>{apiStatus === 'checking' ? 'Comprobando API…' : apiStatus === 'available' ? 'API disponible' : 'API no disponible'}</Status></div>
    <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
      <Panel title="Funciones de la consola" description="Administra los recursos asociados a tu cuenta y revisa el estado de los servicios.">
        <div className="divide-y divide-slate-100">{[
          ['Cuenta', 'Registro, JWT y consulta de identidad', 'account', 'Disponible'],
          ['Dominios', 'Registro, TXT y verificación', 'domains', 'Disponible'],
          ['Reglas de caché', 'Wildcards, límites, TTL y reemplazo', 'rules', 'Disponible'],
          ['Accesos', 'API keys y usuarios por URL', 'access', 'Disponible'],
          ['Acceso a caché', 'Autenticación por recurso y entrega de sesión', 'cache-login', 'Contrato pendiente'],
        ].map(([title, description, target, state]) => <button key={target} type="button" onClick={() => onNavigate(target as View)} className="flex w-full flex-wrap items-center justify-between gap-3 py-4 text-left first:pt-0 last:pb-0"><span><span className="block text-sm font-semibold text-slate-800">{title}</span><span className="mt-1 block text-xs text-slate-500">{description}</span></span><span className="text-xs font-semibold text-indigo-700">{state} · Abrir</span></button>)}</div>
      </Panel>
      <Panel title="Estado de los servicios" description="Rutas disponibles en el código actual; disponibilidad de despliegue depende de sus entornos.">
        <div className="space-y-4"><IntegrationRow name="Node API: cuentas" state="Implementada" detail="Registro, login JWT y consulta de identidad." /><IntegrationRow name="Node API: dominios" state="Implementada" detail="Listado, registro, reto TXT, verificación y eliminación." /><IntegrationRow name="Node API: URLs y accesos" state="Implementada" detail="CRUD de URLs, políticas, API keys y usuarios por URL." /><IntegrationRow name="Zonal Cache y DNS Interceptor" state="Rutas de servicio" detail="La caché consume configuración/credenciales y el interceptor consulta /api/records; su despliegue y conectividad deben verificarse." /><IntegrationRow name="Sesión UI a caché zonal" state="Pendiente" detail="No hay endpoint de login de recursos ni protocolo de traspaso de sesión definido para la UI." /></div>
      </Panel>
    </div>
  </>
}

function IntegrationRow({ name, state, detail }: { name: string; state: string; detail: string }) {
  const ready = state === 'Implementada' || state === 'Rutas de servicio'
  return <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-800">{name}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${ready ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>{state}</span></div>
}

function AccountPage({ session, onAuthenticated, onApiResponded }: { session: Session | null; onAuthenticated: (session: Session) => void; onApiResponded: () => void }) {
  const [registering, setRegistering] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<NoticeState | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setResult(null)
    if (registering && new TextEncoder().encode(password).length > 72) {
      setResult({ tone: 'error', text: 'La contraseña no puede superar 72 bytes.' })
      setBusy(false)
      return
    }
    try {
      if (registering) {
        const account = await api.register(email.trim(), password)
        onApiResponded()
        setRegistering(false)
        setPassword('')
        setResult({ tone: 'success', text: `La cuenta ${account.email} fue creada. Inicia sesión para continuar.` })
      } else {
        onAuthenticated(await api.login(email.trim(), password))
        setPassword('')
        setResult({ tone: 'success', text: 'La Node API confirmó la sesión.' })
      }
    } catch (error) {
      if (error instanceof ApiError && error.status !== undefined) onApiResponded()
      setResult({ tone: 'error', text: error instanceof Error ? error.message : 'No fue posible completar la solicitud.' })
    } finally {
      setBusy(false)
    }
  }

  return <div className="mx-auto max-w-3xl"><PageHeading eyebrow="Cuenta" title={session ? 'Cuenta activa' : registering ? 'Crear cuenta' : 'Iniciar sesión'} description="Las cuentas se almacenan en Firestore por medio de la Node API. La API devuelve un JWT de corta duración; el frontend lo mantiene solo en memoria." />
    <Panel title={session ? 'Cuenta activa' : registering ? 'Registro de usuario' : 'Acceso a la cuenta'} description={session ? session.user.email : 'La contraseña se valida y almacena en el backend; nunca se guarda en el frontend.'}>
      {session ? <p className="text-sm leading-6 text-slate-600">Tu sesión está activa en esta pestaña. Al recargar la página tendrás que iniciar sesión otra vez.</p> : <form className="grid gap-5" onSubmit={submit}>
        <Notice value={result} />
        <label className="grid gap-2 text-sm font-medium text-slate-800"><span>Correo electrónico</span><input className="control" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className="grid gap-2 text-sm font-medium text-slate-800"><span>Contraseña</span><input className="control" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 8 : undefined} maxLength={registering ? 72 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} />{registering && <span className="text-xs font-normal text-slate-500">Al menos 8 caracteres y hasta 72 bytes.</span>}</label>
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy}>{busy ? 'Enviando…' : registering ? 'Crear cuenta' : 'Iniciar sesión'}</Button><Button type="button" secondary disabled={busy} onClick={() => { setRegistering(!registering); setPassword(''); setResult(null) }}>{registering ? 'Ya tengo una cuenta' : 'Crear una cuenta'}</Button></div>
      </form>}
      <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">Endpoints implementados: POST /api/auth/register, POST /api/auth/login y GET /api/auth/me. El cierre de sesión elimina el JWT localmente; el API no ofrece revocación.</p>
    </Panel>
  </div>
}

function PendingPage() {
  return <><PageHeading eyebrow="Autenticación de recursos" title="Acceso a caché zonal" description="El inicio de sesión de una URL protegida es distinto del inicio de sesión de la cuenta de administración." /><div className="mb-5"><Status>Integración pendiente</Status></div><div className="grid gap-5 xl:grid-cols-2"><Panel title="Funciones previstas"><ul className="list-disc space-y-3 pl-5 text-sm leading-6 text-slate-600"><li>Autenticar usuario y contraseña para una URL protegida.</li><li>Entregar una sesión a la caché y permitir verificarla o cerrarla.</li><li>Mantener la sesión dentro del protocolo que acuerden API y caché.</li></ul></Panel><Panel title="Dependencia de API"><p className="text-sm leading-6 text-slate-700">La Node API permite que la caché verifique credenciales de servicio; no define el login de usuarios finales ni un handoff de sesión a la UI.</p><p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">Esta pantalla no envía solicitudes. Requiere que los equipos de API y caché acuerden el protocolo y sus rutas.</p></Panel></div></>
}
