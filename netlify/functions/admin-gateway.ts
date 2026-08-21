import type { createClient as _createClientType } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { createHmac, timingSafeEqual } from 'crypto'

type HandlerEvent = {
  httpMethod: string
  headers: Record<string, string | undefined>
  body: string | null
  isBase64Encoded?: boolean
}

type HandlerResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
}

type AdminSession = {
  user: string
  issuedAt: number
  expiresAt: number
  signature: string
}

type WeeklyLimitsRow = {
  id: number
  week_ymd_start: string
  max_brownies: number
  sold_brownies: number
  created_at: string
  updated_at: string
}

type PromoCodeRow = {
  id: number
  code: string
  label: string
  discount_type: 'percent' | 'fixed' | 'unit_price'
  discount_value: number
  is_active: boolean
  max_uses: number | null
  used_count: number
  created_at: string
  updated_at: string
}

type OrderRow = {
  id: number
  ref: string
  name: string
  phone: string
  email: string
  qty: number
  total: number
  subtotal: number
  delivery_fee: number
  discount: number
  transaction_fee: number
  fulfilment: 'Self-collect' | 'Delivery'
  address: string | null
  notes: string | null
  promo_code: string | null
  payment_method: 'card' | 'paynow'
  source_channel: string | null
  stripe_session_id: string | null
  stripe_payment_intent_id: string | null
  status: 'paid' | 'shipped' | 'cancelled'
  created_at: string
}

type SalesBannerRow = {
  id: number
  message: string
  is_active: boolean
  start_at: string | null
  end_at: string | null
  created_at: string
  updated_at: string
}

type GatewayRequest = {
  action: string
  payload?: unknown
  session: AdminSession | null
}

function jsonResponse(status: number, payload: unknown): HandlerResponse {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify(payload),
  }
}

function ok<T>(data: T) {
  return { ok: true as const, data }
}
function err(error: string) {
  return { ok: false as const, error }
}

function requireEnv(name: string): string {
  const v = (process.env[name] as string | undefined) ?? ''
  if (!v.trim()) {
    throw Object.assign(
      new Error(
        `Missing required server env ${name}. Go to Netlify → Site configuration → Environment variables, add ${name} with the correct value, and redeploy.`,
      ),
      { status: 500 },
    )
  }
  return v.trim()
}

function statusOf(e: unknown, fallback = 500): number {
  if (e && typeof e === 'object' && 'status' in e) {
    const s = (e as { status?: unknown }).status
    if (typeof s === 'number' && s >= 400 && s < 600) return s
  }
  return fallback
}

function messageOf(e: unknown, fallback = 'Internal server error.'): string {
  if (e instanceof Error && e.message && e.message.trim()) return e.message
  if (typeof e === 'string' && e.trim()) return e
  const safe = JSON.stringify(e)
  if (safe && safe !== '{}') return safe
  return fallback
}

function requireAdminEnvFor(action: string, names: string[]): void {
  for (const n of names) {
    const v = (process.env[n] as string | undefined) ?? ''
    if (!v.trim()) {
      throw Object.assign(
        new Error(
          `admin-gateway action "${action}" requires ${names.join(', ')} in Netlify Environment Variables. Missing: ${n}. Add them in Netlify → Site configuration → Environment variables, then redeploy.`,
        ),
        { status: 500 },
      )
    }
  }
}

let _sb: ReturnType<typeof createClient> | null = null
function getServiceSupabase() {
  if (_sb) return _sb
  requireAdminEnvFor('(all DB actions)', ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])
  const url = requireEnv('SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  _sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _sb
}

async function withDbError<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const base = messageOf(e, `admin-gateway action "${action}" failed`)
    let hint = ''
    const lowered = base.toLowerCase()
    if (lowered.includes('relation') && lowered.includes('does not exist')) {
      hint =
        ' (hint: a required Supabase table is missing — open Supabase SQL Editor and run the contents of supabase/migrations/0001_init.sql through 0006_collab_feedback_submissions.sql in order, then retry).'
    } else if (lowered.includes('function') && (lowered.includes('does not exist') || lowered.includes('digest'))) {
      hint =
        ' (hint: required Supabase RPC or pgcrypto extension is missing — open Supabase SQL Editor and run supabase/migrations/0001_init.sql + 0002_force_reenroll_admin.sql, then retry).'
    } else if (lowered.includes('invalid api key') || lowered.includes('jwt') || lowered.includes('401') || lowered.includes('anon')) {
      hint =
        ' (hint: SUPABASE_SERVICE_ROLE_KEY is wrong or was swapped for the anon key — use the service_role secret from Supabase → Project Settings → API.)'
    } else if (lowered.includes('sockettimeout') || lowered.includes('enotfound') || lowered.includes('fetch failed')) {
      hint =
        ' (hint: SUPABASE_URL may be wrong or unreachable from the Function runtime — copy it exactly from Supabase → Project Settings → API → Project URL.)'
    }
    throw Object.assign(new Error(base + hint), { status: statusOf(e, 500) })
  }
}

// Backwards-compat helper — matches the EXACT imul hash adminSignature() that
// existing client sessions carry. This means admins who are currently logged
// in keep their session through the deploy without being logged out. If the
// salt ever rotates (recommended), set BBB_ADMIN_SIGN_ALGO=hmac and migrate
// the signing paths. For now we match the client's exact legacy hash so
// existing sessions remain valid AND verified server-side (forged ones fail
// because attackers cannot compute the same hash without the salt — but note
// the legacy hash is cheap to brute-force; for longer-term safety rotate to
// HMAC with a long random salt below).
function legacyClientHash(payload: string, salt: string): string {
  let hash = 0
  const s = payload + '|' + salt
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i)
    hash |= 0
  }
  return 'h' + (hash >>> 0).toString(16) + (hash * 2654435761 >>> 0).toString(16)
}

function verifyAdminSessionOrThrow(sess: AdminSession | null | undefined): { user: string } {
  if (!sess || !sess.user || !sess.signature || typeof sess.expiresAt !== 'number') {
    throw Object.assign(new Error('Unauthorized: missing admin session.'), { status: 401 })
  }
  const now = Date.now()
  if (now > sess.expiresAt) {
    throw Object.assign(new Error('Unauthorized: admin session expired.'), { status: 401 })
  }
  const salt =
    (process.env.BBB_ADMIN_SIGN_SALT as string | undefined)?.trim() ||
    'bbb-admin-token-v1'
  const algo = ((process.env.BBB_ADMIN_SIGN_ALGO as string | undefined) || 'legacy').trim().toLowerCase()
  const msg = sess.user + '|' + String(sess.issuedAt) + '|' + String(sess.expiresAt)
  let expected: string
  if (algo === 'hmac') {
    expected = createHmac('sha256', salt).update(msg).digest('hex')
  } else {
    expected = legacyClientHash(msg, salt)
  }
  const a = Buffer.from(expected)
  const b = Buffer.from(String(sess.signature))
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    if (expected !== String(sess.signature)) {
      throw Object.assign(new Error('Unauthorized: invalid admin session signature.'), { status: 401 })
    }
  }
  return { user: sess.user }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function signAdminSession(user: string, hours = 8): AdminSession {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + Math.max(1, hours) * 3600 * 1000
  const salt =
    (process.env.BBB_ADMIN_SIGN_SALT as string | undefined)?.trim() ||
    'bbb-admin-token-v1'
  const algo = ((process.env.BBB_ADMIN_SIGN_ALGO as string | undefined) || 'legacy').trim().toLowerCase()
  const msg = user + '|' + String(issuedAt) + '|' + String(expiresAt)
  const signature =
    algo === 'hmac'
      ? createHmac('sha256', salt).update(msg).digest('hex')
      : legacyClientHash(msg, salt)
  return { user, issuedAt, expiresAt, signature }
}

async function actionVerifyAdminLoginViaEnv(payload: unknown): Promise<{ session: AdminSession } | null> {
  const p = (payload ?? {}) as { username?: string; password?: string; hours?: number } | undefined
  const submittedUser = typeof p?.username === 'string' ? p.username.trim() : ''
  const submittedPass = typeof p?.password === 'string' ? p.password : ''
  if (!submittedUser || !submittedPass) return null

  const envUser = ((process.env.BBB_ADMIN_USERNAME as string | undefined) ?? '').trim()
  const envPass = ((process.env.BBB_ADMIN_PASSWORD as string | undefined) ?? '').trim()
  const envUserAlt = ((process.env.BBB_ADMIN_USER as string | undefined) ?? '').trim()
  const envPassAlt = ((process.env.BBB_ADMIN_PASS as string | undefined) ?? '').trim()

  const wantUser = envUser || envUserAlt
  const wantPass = envPass || envPassAlt

  if (!wantUser || !wantPass) {
    // Both username + password env must be set for the env login path to be
    // available. If either is missing, return null cleanly so the DB fallback
    // can run (without wrapping in a throw that bubbles as 401).
    return null
  }

  const userOk = timingSafeEqualStrings(submittedUser.toLowerCase(), wantUser.toLowerCase())
  const passOk =
    timingSafeEqualStrings(submittedPass, wantPass) ||
    (submittedPass.length > 0 && wantPass.length > 0 &&
      timingSafeEqualStrings(submittedPass, wantPass))
  if (!userOk || !passOk) {
    throw Object.assign(new Error('Invalid username or password.'), { status: 401 })
  }
  const hours = typeof p.hours === 'number' && p.hours > 0 && p.hours < 24 * 365 ? p.hours : 8
  return { session: signAdminSession(submittedUser, hours) }
}

async function actionVerifyAdminLoginViaDb(payload: unknown): Promise<{ session: AdminSession } | null> {
  const p = (payload ?? {}) as { username?: string; password?: string; hours?: number } | undefined
  const u = typeof p?.username === 'string' ? p.username.trim() : ''
  const pw = typeof p?.password === 'string' ? p.password : ''
  if (!u || !pw) return null
  const sb = getServiceSupabase()
  const { data, error } = await sb.rpc('verify_admin_login', {
    p_username: u,
    p_password: pw,
  })
  if (error) {
    throw new Error('verify_admin_login RPC error: ' + error.message)
  }
  if (!data) {
    throw Object.assign(new Error('Invalid username or password.'), { status: 401 })
  }
  const hours = typeof p.hours === 'number' && p.hours > 0 && p.hours < 24 * 365 ? p.hours : 8
  return { session: signAdminSession(u, hours) }
}

async function actionVerifyAdminLogin(payload: unknown): Promise<{ session: AdminSession }> {
  // 1) ENV VAR LOGIN (primary, preferred).
  //    Use this path whenever BBB_ADMIN_USERNAME/PASSWORD are set, and ONLY
  //    fall back to the Supabase DB path when the env vars are not configured
  //    at all.
  //    NOTE: the env path can produce two outcomes:
  //      - credentials matched => return signed session (done)
  //      - credentials rejected => 401, STOP (do NOT try the DB fallback — a
  //        typo in env vs a typo from the user would otherwise loop back and
  //        surface the pgcrypto/digest error as the final user-visible failure,
  //        which is exactly the bug reported).
  //      - env vars not set => return null, try DB path next.
  let envLoginAvailable = false
  try {
    const viaEnv = await actionVerifyAdminLoginViaEnv(payload)
    if (viaEnv) return viaEnv
    // If viaEnv returned null without throwing, it means the env vars weren't
    // both set → DB fallback is allowed below.
    envLoginAvailable = false
  } catch (e) {
    // Env vars WERE set AND the submitted creds did not match the env creds.
    // Do NOT continue to DB fallback — surface the 401 immediately.
    throw e
  }

  // 2) DB RPC LOGIN (fallback — only when env login path is disabled).
  try {
    const viaDb = await actionVerifyAdminLoginViaDb(payload)
    if (viaDb) return viaDb
  } catch (e) {
    // If the DB path errors out for infra reasons (e.g. pgcrypto missing,
    // extension not enabled, migrate never ran) AND the env-login path was
    // never configured at all, we still want to surface a useful error to
    // whoever's debugging in prod. Repackage with a hint rather than the
    // raw postgres digest error.
    const dbMsg = e instanceof Error ? e.message : String(e)
    const hints: string[] = []
    if (dbMsg.toLowerCase().includes('digest') || dbMsg.toLowerCase().includes('pgcrypto')) {
      hints.push(
        'Supabase pgcrypto extension / verify_admin_login RPC not deployed. Either (a) run 0001_init.sql in Supabase SQL Editor, or (b) set BBB_ADMIN_USERNAME + BBB_ADMIN_PASSWORD in Netlify env vars (recommended).',
      )
    }
    if (!envLoginAvailable) {
      hints.push('Netlify env login was NOT available — set BBB_ADMIN_USERNAME + BBB_ADMIN_PASSWORD to enable the env login path.')
    }
    const finalMsg = hints.length
      ? hints.join(' ') + ' Underlying DB error: ' + dbMsg
      : dbMsg
    throw Object.assign(new Error(finalMsg), { status: 401 })
  }

  throw Object.assign(new Error('Invalid username or password.'), { status: 401 })
}

// ---- Action handlers --------------------------------------------------------

async function actionLoadLimitsEnsure(payload: unknown) {
  const sb = getServiceSupabase()
  const wantMax = typeof payload === 'number' && payload > 0 ? payload : 100
  const { data, error } = await sb.rpc('ensure_get_weekly_limits', { p_default_max: wantMax })
  if (error) throw new Error('ensure_get_weekly_limits RPC error: ' + error.message)
  return (data as WeeklyLimitsRow) ?? null
}

async function actionSaveMaxBrownies(payload: unknown) {
  const p = payload as { id: number; max_brownies: number } | undefined
  if (!p || typeof p.id !== 'number' || typeof p.max_brownies !== 'number') {
    throw new Error('Invalid payload for saveMaxBrownies.')
  }
  const sb = getServiceSupabase()
  const id = p.id
  const newMax = Math.max(0, Math.floor(p.max_brownies))
  const { data, error } = await sb
    .from('weekly_limits')
    .update({ max_brownies: newMax, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('update weekly_limits: ' + error.message)
  return { row: (data as WeeklyLimitsRow) ?? null, error: null }
}

async function actionResetSold(payload: unknown) {
  const p = payload as { id: number } | undefined
  if (!p || typeof p.id !== 'number') throw new Error('Invalid payload for resetSold.')
  const sb = getServiceSupabase()
  const { data, error } = await sb.rpc('reset_weekly_sold_for_new_week', { p_row_id: p.id })
  if (error) throw new Error('reset_weekly_sold_for_new_week RPC error: ' + error.message)
  return { row: (data as WeeklyLimitsRow) ?? null, error: null }
}

async function actionDeleteOrdersBefore(payload: unknown) {
  const p = payload as { beforeIso: string } | undefined
  if (!p || typeof p.beforeIso !== 'string') throw new Error('Invalid payload for deleteOrdersBefore.')
  const sb = getServiceSupabase()
  const { count, error } = await sb
    .from('orders')
    .delete({ count: 'exact' })
    .lt('created_at', p.beforeIso)
  if (error) throw new Error('delete orders before: ' + error.message)
  return { deleted: Number(count ?? 0), error: null }
}

async function actionLoadPromos() {
  const sb = getServiceSupabase()
  const { data, error } = await sb
    .from('promo_codes')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw new Error('select promo_codes: ' + error.message)
  return { data: (data as PromoCodeRow[]) ?? [] }
}

async function actionAddPromo(payload: unknown) {
  const p = payload as Partial<PromoCodeRow> | undefined
  if (!p || !p.code || !p.label || typeof p.discount_value !== 'number' || !p.discount_type) {
    throw new Error('Invalid payload for addPromo.')
  }
  const sb = getServiceSupabase()
  const insert = {
    code: String(p.code).trim().toUpperCase(),
    label: p.label,
    discount_type: p.discount_type,
    discount_value: p.discount_value,
    is_active: typeof p.is_active === 'boolean' ? p.is_active : true,
    max_uses: p.max_uses === undefined || p.max_uses === null || p.max_uses === '' ? null : Number(p.max_uses),
  } as PromoCodeRow
  const { data, error } = await sb
    .from('promo_codes')
    .insert([insert])
    .select()
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('insert promo_codes: ' + error.message)
  return { data: (data as PromoCodeRow) ?? null, error: null }
}

async function actionUpdatePromo(payload: unknown) {
  const p = payload as { id: number; patch: Partial<PromoCodeRow> } | undefined
  if (!p || typeof p.id !== 'number' || !p.patch || typeof p.patch !== 'object') {
    throw new Error('Invalid payload for updatePromo.')
  }
  const sb = getServiceSupabase()
  const allPatches: Partial<PromoCodeRow> & Record<string, unknown> = {
    ...p.patch,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await sb
    .from('promo_codes')
    .update(allPatches)
    .eq('id', p.id)
    .select()
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('update promo_codes: ' + error.message)
  return { data: (data as PromoCodeRow) ?? null, error: null }
}

async function actionDeletePromo(payload: unknown) {
  const p = payload as { id: number } | undefined
  if (!p || typeof p.id !== 'number') throw new Error('Invalid payload for deletePromo.')
  const sb = getServiceSupabase()
  const { error } = await sb.from('promo_codes').delete().eq('id', p.id)
  if (error) throw new Error('delete promo_codes: ' + error.message)
  return { ok: true, error: null }
}

async function actionLoadOrders(payload: unknown) {
  const p = (payload ?? {}) as { limit?: number }
  const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : 200
  const sb = getServiceSupabase()
  const { data, error } = await sb
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error('select orders: ' + error.message)
  return { data: (data as OrderRow[]) ?? [] }
}

async function actionUpdateOrderStatus(payload: unknown) {
  const p = payload as { id: number; status: OrderRow['status'] } | undefined
  if (
    !p ||
    typeof p.id !== 'number' ||
    (p.status !== 'paid' && p.status !== 'shipped' && p.status !== 'cancelled')
  ) {
    throw new Error('Invalid payload for updateOrderStatus.')
  }
  const sb = getServiceSupabase()
  const { error } = await sb
    .from('orders')
    .update({ status: p.status } as Record<string, unknown>)
    .eq('id', p.id)
  if (error) throw new Error('update orders status: ' + error.message)
  return { ok: true, error: null }
}

async function actionLoadBanner() {
  const sb = getServiceSupabase()
  const { data, error } = await sb
    .from('sales_banners')
    .select('*')
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('select sales_banners: ' + error.message)
  return (data as SalesBannerRow) ?? null
}

async function actionSaveBanner(payload: unknown) {
  type Patch = {
    message: string
    is_active: boolean
    start_at: string | null
    end_at: string | null
  }
  const p = payload as Patch | undefined
  if (!p || typeof p.message !== 'string' || typeof p.is_active !== 'boolean') {
    throw new Error('Invalid payload for saveBanner.')
  }
  const sb = getServiceSupabase()
  try {
    const { error: quashErr } = await sb
      .from('sales_banners')
      .update({ is_active: false } as Record<string, unknown>)
      .neq('id', 1)
      .is('is_active', true)
    if (quashErr) {
      // Continue anyway — the real update below may still succeed.
      console.warn('[banner] adminSaveBanner preflight quash-other-actives warn:', quashErr.message)
    }
  } catch (e) {
    console.warn('[banner] adminSaveBanner preflight quash-other-actives failed:', e)
  }
  try {
    const { error: ensureErr } = await sb
      .from('sales_banners')
      .upsert(
        [
          {
            id: 1,
            message: p.message,
            is_active: !!p.is_active,
            start_at: p.start_at ?? null,
            end_at: p.end_at ?? null,
          },
        ],
        { onConflict: 'id' },
      )
    if (ensureErr) {
      console.warn('[banner] adminSaveBanner preflight upsert warn:', ensureErr.message)
    }
  } catch (e) {
    console.warn('[banner] adminSaveBanner preflight upsert failed:', e)
  }
  const { data, error } = await sb
    .from('sales_banners')
    .update({
      message: p.message,
      is_active: !!p.is_active,
      start_at: p.start_at ?? null,
      end_at: p.end_at ?? null,
      updated_at: new Date().toISOString(),
    } as Record<string, unknown>)
    .eq('id', 1)
    .select()
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('update sales_banners: ' + error.message)
  return (data as SalesBannerRow) ?? null
}

// ---- Dispatcher ------------------------------------------------------------

export async function handler(event: HandlerEvent): Promise<HandlerResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {})
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, err('Method not allowed. Use POST.'))
  }
  let body: GatewayRequest
  try {
    if (!event.body) throw new Error('Missing JSON body.')
    body = JSON.parse(event.body) as GatewayRequest
  } catch (e) {
    return jsonResponse(400, err('Invalid JSON body: ' + (e instanceof Error ? e.message : String(e))))
  }

  const action = String(body.action || '')

  // verifyAdminLogin MUST run BEFORE the verifyAdminSessionOrThrow check below,
  // because a caller attempting to log in does NOT have a signed session yet.
  // Any other action is only executed with a valid session.
  if (action === 'verifyAdminLogin') {
    try {
      return jsonResponse(200, ok(await actionVerifyAdminLogin(body.payload)))
    } catch (e) {
      const status = e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number'
        ? (e as { status: number }).status
        : 401
      const msg = e instanceof Error ? e.message : String(e)
      return jsonResponse(status, err(msg))
    }
  }

  // Verify session FIRST before any DB action runs.
  try {
    verifyAdminSessionOrThrow(body.session)
  } catch (e) {
    const status = e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number'
      ? (e as { status: number }).status
      : 401
    const msg = e instanceof Error ? e.message : String(e)
    return jsonResponse(status, err(msg))
  }

  try {
    switch (action) {
      case 'loadLimitsEnsure':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionLoadLimitsEnsure(body.payload))),
        )
      case 'saveMaxBrownies':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionSaveMaxBrownies(body.payload))),
        )
      case 'resetSold':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionResetSold(body.payload))),
        )
      case 'deleteOrdersBefore':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionDeleteOrdersBefore(body.payload))),
        )
      case 'loadPromos':
        return jsonResponse(200, ok(await withDbError(action, () => actionLoadPromos())))
      case 'addPromo':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionAddPromo(body.payload))),
        )
      case 'updatePromo':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionUpdatePromo(body.payload))),
        )
      case 'deletePromo':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionDeletePromo(body.payload))),
        )
      case 'loadOrders':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionLoadOrders(body.payload))),
        )
      case 'updateOrderStatus':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionUpdateOrderStatus(body.payload))),
        )
      case 'loadBanner':
        return jsonResponse(200, ok(await withDbError(action, () => actionLoadBanner())))
      case 'saveBanner':
        return jsonResponse(
          200,
          ok(await withDbError(action, () => actionSaveBanner(body.payload))),
        )
      default:
        return jsonResponse(400, err(`Unknown action: ${action}`))
    }
  } catch (e) {
    const status = statusOf(e, 500)
    const msg = messageOf(e, `admin-gateway action "${action}" failed`)
    return jsonResponse(status, err(msg))
  }
}

// Unused-but-type-imported references — keeps TS happy when import elision is
// conservative. The `type` prefix makes this a type-only import at the top
// already, but some bundlers/tsconfigs still complain; referencing the types
// in never-executed dead code silences them without any runtime cost.
void (undefined as unknown as typeof _createClientType)
void (undefined as unknown as Stripe)
