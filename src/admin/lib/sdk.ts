import Medusa from '@medusajs/js-sdk'

/**
 * The dashboard defines `__BACKEND_URL__` when it bundles a plugin's admin
 * extensions, and it only differs from the current origin when the dashboard is
 * served separately from the Medusa server. Read through `typeof` because
 * nothing defines it while `medusa plugin:build` compiles this package on its
 * own, and an undefined global would throw rather than fall back.
 */
const backendUrl = typeof __BACKEND_URL__ === 'string' ? __BACKEND_URL__ : '/'

/** The dashboard authenticates with a session cookie, so its widgets do too. */
export const sdk = new Medusa({
  baseUrl: backendUrl,
  auth: { type: 'session' },
})
