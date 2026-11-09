const value = process.env.API_PROXY_ORIGIN
if (!value) throw new Error('Set API_PROXY_ORIGIN to the HTTPS Node API origin in Vercel')
const api = new URL(value)
if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) {
  throw new Error('API_PROXY_ORIGIN must be an HTTPS origin without a path or credentials')
}

export const config = {
  framework: 'vite',
  installCommand: 'pnpm install --frozen-lockfile',
  buildCommand: 'pnpm run build',
  outputDirectory: 'dist',
  rewrites: [
    { source: '/api/:path*', destination: `${api.origin}/api/:path*` },
    { source: '/((?!api(?:/|$)|_vercel(?:/|$)).*)', destination: '/index.html' },
  ],
}
