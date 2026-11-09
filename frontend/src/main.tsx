import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { CacheLoginPage } from './CacheLoginPage'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname === '/cache-login' ? <CacheLoginPage /> : <App />}
    <footer className="px-5 py-4 text-center text-xs text-slate-500"><a className="underline" href="https://db-ip.com">IP Geolocation by DB-IP</a> · CC BY 4.0</footer>
  </StrictMode>,
)
