/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // O app antigo (JavaScript puro, public/index.html) não é mais servido: tudo abre no app novo.
  async redirects() {
    return [
      { source: '/', destination: '/rotas', permanent: false },
      { source: '/index.html', destination: '/rotas', permanent: false },
    ];
  },
  async headers() {
    return [
      { source: '/sw.js', headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ] },
      { source: '/manifest.json', headers: [
        { key: 'Content-Type', value: 'application/manifest+json' },
        { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
      ] },
      { source: '/vendor/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/:path*', headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=(self)' },
      ] },
    ];
  },
};
export default nextConfig;
