import Medusa from '@medusajs/js-sdk'

/**
 * The dashboard defines `__BACKEND_URL__` when it bundles a plugin's admin
 * extensions, and it only differs from the current origin when the dashboard is
 * served separately from the Medusa server. Read through `typeof` because
 * nothing defines it while `medusa plugin:build` compiles this package on its
 * own, and an undefined global would throw rather than fall back.
 */
const backendUrl = typeof __BACKEND_URL__ === 'string' ? __BACKEND_URL__ : '/'

/**
 * A dashboard built with `ADMIN_AUTH_TYPE=jwt` holds its token in storage and
 * sends no session cookie, so a widget hardcoding `session` sends no
 * credentials at all and every admin call answers 401. The bundler defines
 * `__AUTH_TYPE__` and `__JWT_TOKEN_STORAGE_KEY__` beside `__BACKEND_URL__`;
 * read them the same guarded way and let the host decide.
 */
const authType = typeof __AUTH_TYPE__ === 'string' ? __AUTH_TYPE__ : 'session'
const jwtTokenStorageKey = typeof __JWT_TOKEN_STORAGE_KEY__ === 'string' ? __JWT_TOKEN_STORAGE_KEY__ : undefined

/** The widgets authenticate exactly as the dashboard that hosts them does. */
export const sdk = new Medusa({
  baseUrl: backendUrl,
  auth: { type: authType, jwtTokenStorageKey },
})
