import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, api, type ApiKey, type Domain, type UrlRule, type UrlRuleInput, type UrlUser } from './api'

type Props = { signedIn: boolean; onUnauthorized: () => void }
type Message = { tone: 'error' | 'success' | 'info'; text: string } | null

function errorText(error: unknown, onUnauthorized: () => void) {
  if (error instanceof ApiError && error.status === 401) onUnauthorized()
  return error instanceof Error ? error.message : 'No fue posible completar la solicitud.'
}

function MessageBox({ message }: { message: Message }) {
  if (!message) return null
  const style = message.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : message.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'
  return <p role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${style}`}>{message.text}</p>
}

function NoticeSignIn({ signedIn }: { signedIn: boolean }) {
  return signedIn ? null : <p role="status" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Inicia sesión con tu cuenta para administrar estos recursos.</p>
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 className="text-base font-semibold text-slate-950">{title}</h2><div className="mt-4">{children}</div></section>
}

function Action({ children, secondary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button {...props} className={`inline-flex min-h-10 items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50' : 'bg-indigo-600 text-white hover:bg-indigo-700'} ${props.className ?? ''}`}>{children}</button>
}

const fieldClass = 'control'

export function DomainsPage({ signedIn, onUnauthorized }: Props) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)

  useEffect(() => {
    let active = true
    if (signedIn) void api.listDomains().then((value) => { if (active) setDomains(value) }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    return () => { active = false }
  }, [signedIn, onUnauthorized])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const created = await api.createDomain(domain.trim())
      setDomains((current) => [...current.filter((item) => item.domain !== created.domain), created])
      setDomain(''); setMessage({ tone: 'success', text: created.instructions })
    } catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }

  async function verify(item: Domain) {
    setBusy(true); setMessage(null)
    try {
      const result = await api.verifyDomain(item.domain)
      setDomains((current) => current.map((domainItem) => domainItem.domain === result.domain ? { ...domainItem, ...result, txt: result.verified ? undefined : result.txt ?? domainItem.txt } : domainItem))
      setMessage({ tone: result.verified ? 'success' : 'info', text: result.verified ? `${item.domain} quedó verificado.` : result.message || 'El TXT todavía no se encuentra en DNS. Revisa el registro y vuelve a intentar.' })
    } catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }

  async function remove(item: Domain) {
    if (!window.confirm(`¿Eliminar ${item.domain} y todas sus URLs, claves y usuarios?`)) return
    setBusy(true); setMessage(null)
    try { await api.deleteDomain(item.domain); setDomains((current) => current.filter((entry) => entry.domain !== item.domain)); setMessage({ tone: 'success', text: `${item.domain} fue eliminado.` }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }

  return <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]"><NoticeSignIn signedIn={signedIn} /><Card title="Registrar un dominio">
    <form className="grid gap-4" onSubmit={create}><label className="grid gap-2 text-sm font-medium">Dominio o wildcard<input className={fieldClass} required maxLength={255} placeholder="ejemplo.com o *.ejemplo.com" value={domain} onChange={(event) => setDomain(event.target.value)} /></label><Action disabled={!signedIn || busy}>{busy ? 'Procesando…' : 'Registrar dominio'}</Action><MessageBox message={message} /></form>
    <p className="mt-4 text-xs leading-5 text-slate-500">La API devuelve el nombre y valor TXT únicos que debes publicar en DNS. La verificación consulta el DNS y habilita el dominio para los servicios.</p>
  </Card><Card title="Mis dominios">
    {!signedIn ? <p className="text-sm text-slate-500">La lista aparece al iniciar sesión.</p> : domains.length === 0 ? <p className="text-sm text-slate-500">Aún no hay dominios registrados.</p> : <div className="space-y-4">{domains.map((item) => <article key={item.domain} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{item.domain}</h3><p className={`mt-1 text-xs font-semibold ${item.verified ? 'text-emerald-700' : 'text-amber-800'}`}>{item.verified ? `Verificado${item.verifiedAt ? ` · ${new Date(item.verifiedAt).toLocaleString()}` : ''}` : 'Pendiente de verificación TXT'}</p></div><div className="flex gap-2"><Action secondary disabled={busy || item.verified} onClick={() => void verify(item)}>{item.verified ? 'Verificado' : 'Verificar TXT'}</Action><Action secondary disabled={busy} onClick={() => void remove(item)}>Eliminar</Action></div></div>{item.txt && <dl className="mt-4 grid gap-2 rounded-lg bg-slate-50 p-3 text-xs sm:grid-cols-[5rem_1fr]"><dt className="font-semibold text-slate-600">Tipo</dt><dd>{item.txt.type}</dd><dt className="font-semibold text-slate-600">Nombre</dt><dd className="break-all font-mono">{item.txt.name}</dd><dt className="font-semibold text-slate-600">Valor</dt><dd className="break-all font-mono">{item.txt.value}</dd></dl>}</article>)}</div>}
  </Card></div>
}

type RuleForm = { pattern: string; origin: string; cacheSizeMB: string; fileTypes: { ext: string; ttlSeconds: string }[]; replacementPolicy: UrlRuleInput['replacementPolicy']; authType: UrlRuleInput['authType'] }
const emptyRule: RuleForm = { pattern: '/', origin: '', cacheSizeMB: '100', fileTypes: [{ ext: 'html', ttlSeconds: '3600' }], replacementPolicy: 'LRU', authType: 'none' }
const policies: UrlRuleInput['replacementPolicy'][] = ['LRU', 'LFU', 'FIFO', 'MRU', 'RANDOM']

export function RulesPage({ signedIn, onUnauthorized }: Props) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [domain, setDomain] = useState('')
  const [urls, setUrls] = useState<UrlRule[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<RuleForm>(emptyRule)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)

  useEffect(() => {
    let active = true
    if (signedIn) void api.listDomains().then((value) => { if (active) { setDomains(value); setDomain((current) => current || value.find((item) => item.verified)?.domain || value[0]?.domain || '') } }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    return () => { active = false }
  }, [signedIn, onUnauthorized])

  useEffect(() => {
    let active = true
    if (signedIn && domain) void api.listUrls(domain).then((value) => { if (active) setUrls(value) }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    return () => { active = false }
  }, [signedIn, domain, onUnauthorized])

  function edit(item: UrlRule) {
    setEditing(item.id)
    setForm({ pattern: item.pattern, origin: item.origin, cacheSizeMB: String(item.cacheSizeMB), fileTypes: item.fileTypes.map((file) => ({ ext: file.ext, ttlSeconds: String(file.ttlSeconds) })), replacementPolicy: item.replacementPolicy, authType: item.authType })
    setMessage(null)
  }
  function reset() { setEditing(null); setForm({ ...emptyRule, fileTypes: [...emptyRule.fileTypes] }) }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null)
    const input: UrlRuleInput = { pattern: form.pattern.trim(), origin: form.origin.trim(), cacheSizeMB: Number(form.cacheSizeMB), fileTypes: form.fileTypes.filter((file) => file.ext.trim()).map((file) => ({ ext: file.ext.trim(), ttlSeconds: Number(file.ttlSeconds) })), replacementPolicy: form.replacementPolicy, authType: form.authType }
    try {
      const saved = editing ? await api.updateUrl(editing, input) : await api.createUrl(domain, input)
      setUrls((current) => editing ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])
      reset(); setMessage({ tone: 'success', text: editing ? 'La configuración fue actualizada.' : 'La regla de caché fue creada.' })
    } catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }

  async function remove(item: UrlRule) {
    if (!window.confirm(`¿Eliminar la regla ${item.pattern}? También se eliminarán sus claves y usuarios.`)) return
    setBusy(true); setMessage(null)
    try { await api.deleteUrl(item.id); setUrls((current) => current.filter((entry) => entry.id !== item.id)); if (editing === item.id) reset(); setMessage({ tone: 'success', text: 'La regla fue eliminada.' }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }

  return <div className="grid gap-5 xl:grid-cols-2"><NoticeSignIn signedIn={signedIn} /><Card title={editing ? 'Editar regla' : 'Nueva regla de caché'}>
    {!signedIn ? <p className="text-sm text-slate-500">Inicia sesión para administrar reglas.</p> : domains.length === 0 ? <p className="text-sm text-slate-500">Registra un dominio antes de crear URLs.</p> : <form className="grid gap-4" onSubmit={save}>
      <label className="grid gap-2 text-sm font-medium">Dominio<select className={fieldClass} required value={domain} onChange={(event) => { setDomain(event.target.value); setUrls([]); reset() }}>{domains.map((item) => <option key={item.domain} value={item.domain}>{item.domain}{item.verified ? '' : ' · TXT pendiente'}</option>)}</select></label>
      <label className="grid gap-2 text-sm font-medium">Patrón wildcard<input className={fieldClass} required maxLength={200} pattern="/.*" placeholder="/imagenes/*" value={form.pattern} onChange={(event) => setForm({ ...form, pattern: event.target.value })} /></label>
      <label className="grid gap-2 text-sm font-medium">Origen HTTP/HTTPS<input className={fieldClass} required type="url" placeholder="http://apache:80" value={form.origin} onChange={(event) => setForm({ ...form, origin: event.target.value })} /></label>
      <label className="grid gap-2 text-sm font-medium">Tamaño máximo de caché (MB)<input className={fieldClass} required type="number" min="1" step="1" value={form.cacheSizeMB} onChange={(event) => setForm({ ...form, cacheSizeMB: event.target.value })} /></label>
      <fieldset className="grid gap-3"><legend className="mb-2 text-sm font-medium">Tipos de archivo y TTL (segundos)</legend>{form.fileTypes.map((file, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2"><label className="sr-only" htmlFor={`ext-${index}`}>Extensión</label><input id={`ext-${index}`} className={fieldClass} required maxLength={10} pattern="[A-Za-z0-9]{1,10}" placeholder="jpg" value={file.ext} onChange={(event) => setForm({ ...form, fileTypes: form.fileTypes.map((row, i) => i === index ? { ...row, ext: event.target.value } : row) })} /><label className="sr-only" htmlFor={`ttl-${index}`}>TTL en segundos</label><input id={`ttl-${index}`} className={fieldClass} required type="number" min="0" max="31536000" step="1" placeholder="3600" value={file.ttlSeconds} onChange={(event) => setForm({ ...form, fileTypes: form.fileTypes.map((row, i) => i === index ? { ...row, ttlSeconds: event.target.value } : row) })} /><Action type="button" secondary aria-label="Quitar tipo de archivo" onClick={() => setForm({ ...form, fileTypes: form.fileTypes.filter((_, i) => i !== index) })}>×</Action></div>)}<Action type="button" secondary className="justify-self-start" onClick={() => setForm({ ...form, fileTypes: [...form.fileTypes, { ext: '', ttlSeconds: '3600' }] })}>Agregar tipo de archivo</Action></fieldset>
      <label className="grid gap-2 text-sm font-medium">Política de reemplazo<select className={fieldClass} value={form.replacementPolicy} onChange={(event) => setForm({ ...form, replacementPolicy: event.target.value as RuleForm['replacementPolicy'] })}>{policies.map((policy) => <option key={policy}>{policy}</option>)}</select></label>
      <label className="grid gap-2 text-sm font-medium">Autenticación de la URL<select className={fieldClass} value={form.authType} onChange={(event) => setForm({ ...form, authType: event.target.value as RuleForm['authType'] })}><option value="none">Sin autenticación</option><option value="apikey">API key</option><option value="userpass">Usuario y contraseña</option></select></label>
      <div className="flex flex-wrap gap-2"><Action disabled={busy || !domain}>{busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear regla'}</Action>{editing && <Action type="button" secondary onClick={reset}>Cancelar edición</Action>}</div><MessageBox message={message} />
    </form>}
  </Card><Card title={`URLs de ${domain || 'dominio'}${domain && !domains.find((item) => item.domain === domain)?.verified ? ' · dominio no verificado' : ''}`}>
    {!signedIn ? <p className="text-sm text-slate-500">Inicia sesión para ver las URLs.</p> : urls.length === 0 ? <p className="text-sm text-slate-500">No hay reglas para este dominio.</p> : <div className="space-y-3">{urls.map((item) => <article key={item.id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><h3 className="break-all font-semibold">{item.pattern}</h3><p className="mt-1 break-all text-xs text-slate-500">{item.origin}</p></div><span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-800">{item.authType}</span></div><p className="mt-3 text-xs text-slate-600">{item.cacheSizeMB} MB · {item.replacementPolicy} · {item.fileTypes.map((file) => `.${file.ext}: ${file.ttlSeconds}s`).join(', ') || 'sin TTL por tipo'}</p><div className="mt-3 flex gap-2"><Action secondary disabled={busy} onClick={() => edit(item)}>Editar</Action><Action secondary disabled={busy} onClick={() => void remove(item)}>Eliminar</Action></div></article>)}</div>}
  </Card></div>
}

export function AccessPage({ signedIn, onUnauthorized }: Props) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [domain, setDomain] = useState('')
  const [urls, setUrls] = useState<UrlRule[]>([])
  const [urlId, setUrlId] = useState('')
  const [keyList, setKeyList] = useState<{ urlId: string; items: ApiKey[] } | null>(null)
  const [userList, setUserList] = useState<{ urlId: string; items: UrlUser[] } | null>(null)
  const [createdKey, setCreatedKey] = useState<{ urlId: string; value: string } | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordEdits, setPasswordEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const selectedUrl = urls.find((item) => item.id === urlId)
  const keys = keyList?.urlId === urlId ? keyList.items : []
  const users = userList?.urlId === urlId ? userList.items : []

  useEffect(() => {
    let active = true
    if (signedIn) void api.listDomains().then((value) => { if (active) { setDomains(value); setDomain((current) => current || value[0]?.domain || '') } }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    return () => { active = false }
  }, [signedIn, onUnauthorized])
  useEffect(() => {
    let active = true
    if (signedIn && domain) void api.listUrls(domain).then((value) => { if (active) { setUrls(value); setUrlId((current) => value.some((item) => item.id === current) ? current : value[0]?.id || '') } }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    return () => { active = false }
  }, [signedIn, domain, onUnauthorized])
  useEffect(() => {
    let active = true
    if (signedIn && selectedUrl?.authType === 'apikey') void api.listApiKeys(urlId).then((value) => { if (active) setKeyList({ urlId, items: value }) }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    if (signedIn && selectedUrl?.authType === 'userpass') void api.listUsers(urlId).then((value) => { if (active) setUserList({ urlId, items: value }) }).catch((error) => { if (active) setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) })
    return () => { active = false }
  }, [signedIn, urlId, selectedUrl?.authType, onUnauthorized])

  async function createKey() {
    setBusy(true); setMessage(null)
    try { const { apiKey, ...metadata } = await api.createApiKey(urlId); setKeyList({ urlId, items: [...keys, metadata] }); setCreatedKey({ urlId, value: apiKey }); setMessage({ tone: 'success', text: 'La clave completa solo se muestra ahora. Cópiala y guárdala de forma segura.' }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }
  async function removeKey(key: ApiKey) {
    if (!window.confirm(`¿Revocar la clave ${key.prefix}…?`)) return
    setBusy(true); setMessage(null)
    try { await api.deleteApiKey(key.id); setKeyList({ urlId, items: keys.filter((entry) => entry.id !== key.id) }); setMessage({ tone: 'success', text: 'La clave fue revocada.' }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }
  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null)
    if (new TextEncoder().encode(password).length > 72) { setMessage({ tone: 'error', text: 'La contraseña no puede superar 72 bytes.' }); setBusy(false); return }
    try { const user = await api.createUser(urlId, username.trim(), password); setUserList({ urlId, items: [...users, user] }); setUsername(''); setPassword(''); setMessage({ tone: 'success', text: `El usuario ${user.username} fue creado.` }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }
  async function updateUser(usernameValue: string) {
    const nextPassword = passwordEdits[usernameValue] || ''
    if (nextPassword.length < 8 || new TextEncoder().encode(nextPassword).length > 72) { setMessage({ tone: 'error', text: 'La contraseña debe tener al menos 8 caracteres y no superar 72 bytes.' }); return }
    setBusy(true); setMessage(null)
    try { await api.updateUser(urlId, usernameValue, nextPassword); setPasswordEdits((current) => ({ ...current, [usernameValue]: '' })); setMessage({ tone: 'success', text: `La contraseña de ${usernameValue} fue actualizada.` }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }
  async function removeUser(user: UrlUser) {
    if (!window.confirm(`¿Eliminar el usuario ${user.username}?`)) return
    setBusy(true); setMessage(null)
    try { await api.deleteUser(urlId, user.username); setUserList({ urlId, items: users.filter((entry) => entry.username !== user.username) }); setMessage({ tone: 'success', text: `El usuario ${user.username} fue eliminado.` }) }
    catch (error) { setMessage({ tone: 'error', text: errorText(error, onUnauthorized) }) } finally { setBusy(false) }
  }

  return <div className="grid gap-5 xl:grid-cols-2"><NoticeSignIn signedIn={signedIn} /><Card title="Seleccionar URL">
    {!signedIn ? <p className="text-sm text-slate-500">Inicia sesión para administrar credenciales.</p> : domains.length === 0 ? <p className="text-sm text-slate-500">Registra un dominio y crea una URL para gestionar sus accesos.</p> : <div className="grid gap-4"><label className="grid gap-2 text-sm font-medium">Dominio<select className={fieldClass} value={domain} onChange={(event) => { setDomain(event.target.value); setUrls([]); setUrlId(''); setCreatedKey(null) }}>{domains.map((item) => <option key={item.domain}>{item.domain}</option>)}</select></label><label className="grid gap-2 text-sm font-medium">URL<select className={fieldClass} value={urlId} onChange={(event) => { setUrlId(event.target.value); setCreatedKey(null) }}>{urls.map((item) => <option key={item.id} value={item.id}>{item.pattern} · {item.authType}</option>)}</select></label>{selectedUrl && <p className="text-xs leading-5 text-slate-500">La URL usa {selectedUrl.authType === 'apikey' ? 'API keys' : selectedUrl.authType === 'userpass' ? 'usuarios y contraseña' : 'sin autenticación'}.</p>}</div>}
      </Card><Card title="Credenciales de la URL">
    {!signedIn || !selectedUrl ? <p className="text-sm text-slate-500">Selecciona una URL para continuar.</p> : selectedUrl.authType === 'none' ? <p className="text-sm text-slate-500">Esta URL no requiere credenciales. Cambia su modo de autenticación en Reglas de caché.</p> : selectedUrl.authType === 'apikey' ? <div className="grid gap-4"><Action disabled={busy} onClick={() => void createKey()}>{busy ? 'Procesando…' : 'Crear API key'}</Action>{createdKey?.urlId === urlId && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm font-semibold text-amber-950">Copia esta clave ahora; no volverá a mostrarse:</p><code className="mt-2 block break-all text-sm text-amber-900">{createdKey.value}</code><button type="button" className="mt-2 text-sm font-semibold underline" onClick={() => void navigator.clipboard?.writeText(createdKey.value)}>Copiar clave</button></div>}{keys.length === 0 ? <p className="text-sm text-slate-500">No hay claves activas.</p> : keys.map((key) => <div key={key.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><span className="text-sm"><code>{key.prefix}…</code><span className="ml-2 text-xs text-slate-500">{key.createdAt ? new Date(key.createdAt).toLocaleDateString() : ''}</span></span><Action secondary disabled={busy} onClick={() => void removeKey(key)}>Revocar</Action></div>)}</div> : <div className="grid gap-5"><form className="grid gap-3 rounded-xl bg-slate-50 p-4" onSubmit={saveUser}><h3 className="text-sm font-semibold">Agregar usuario</h3><label className="grid gap-2 text-sm">Nombre de usuario<input className={fieldClass} required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className="grid gap-2 text-sm">Contraseña<input className={fieldClass} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /><span className="text-xs text-slate-500">Al menos 8 caracteres; máximo 72 bytes.</span></label><Action disabled={busy}>{busy ? 'Guardando…' : 'Crear usuario'}</Action></form>{users.length === 0 ? <p className="text-sm text-slate-500">No hay usuarios registrados.</p> : users.map((user) => <div key={user.username} className="grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-[1fr_auto]"><div><p className="font-semibold">{user.username}</p><p className="text-xs text-slate-500">Contraseña protegida; no se puede consultar.</p><label className="mt-3 grid gap-2 text-sm">Cambiar contraseña<input className={fieldClass} type="password" minLength={8} value={passwordEdits[user.username] || ''} onChange={(event) => setPasswordEdits((current) => ({ ...current, [user.username]: event.target.value }))} /></label></div><div className="flex flex-wrap gap-2 sm:flex-col sm:items-end"><Action secondary disabled={busy} onClick={() => void updateUser(user.username)}>Actualizar</Action><Action secondary disabled={busy} onClick={() => void removeUser(user)}>Eliminar</Action></div></div>)}</div>}
    <div className="mt-4"><MessageBox message={message} /></div>
  </Card></div>
}
