import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'

export default function App() {
  return (
    <div className="mx-auto flex min-h-svh max-w-6xl flex-col px-6 sm:px-10">
      <header className="flex items-center justify-between gap-4 border-b border-stone-200 py-7">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-stone-900 text-sm font-semibold text-white" aria-hidden="true">
            P2
          </span>
          <p className="text-sm font-semibold tracking-tight">Redes <span className="font-normal text-stone-500">/ IC7602</span></p>
        </div>
        <span className="text-xs text-stone-600">Proyecto 02</span>
      </header>

      <main className="flex flex-1 flex-col justify-center py-16 sm:py-24">
        <p className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-700">
          <span className="size-1.5 rounded-full bg-blue-700" aria-hidden="true" />
          Configuración inicial
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-balance sm:text-6xl">
          Proxy y caché con geolocalización.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-stone-600 sm:text-lg">
          Un espacio para administrar dominios, configurar reglas de caché y gestionar el acceso a los recursos.
        </p>

        <section aria-labelledby="status-heading" className="mt-14 grid gap-8 border-t border-stone-200 pt-8 md:grid-cols-[1fr_2fr] md:gap-16">
          <div>
            <h2 id="status-heading" className="text-sm font-semibold">Estado del proyecto</h2>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-stone-600">
              La base de la aplicación está lista. Las funciones de administración se implementarán en la siguiente etapa.
            </p>
          </div>
          <dl className="divide-y divide-stone-200 text-sm">
            <div className="flex items-center justify-between gap-4 pb-4">
              <dt>Dominios y verificación DNS</dt>
              <dd className="shrink-0 text-stone-500">Pendiente</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-4">
              <dt>URLs y políticas de caché</dt>
              <dd className="shrink-0 text-stone-500">Pendiente</dd>
            </div>
            <div className="flex items-center justify-between gap-4 pt-4">
              <dt>Usuarios y claves de acceso</dt>
              <dd className="shrink-0 text-stone-500">Pendiente</dd>
            </div>
          </dl>
        </section>
      </main>

      <footer className="flex flex-wrap justify-between gap-x-6 gap-y-2 border-t border-stone-200 py-6 text-xs text-stone-600">
        <p>Tecnológico de Costa Rica</p>
        <p>IC7602 · Segundo semestre 2026</p>
      </footer>

      <Analytics />
      <SpeedInsights />
    </div>
  )
}
