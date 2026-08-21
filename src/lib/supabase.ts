import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let _anonClient: SupabaseClient | null | undefined = undefined

export function supabaseAnon(): SupabaseClient | null {
  if (_anonClient !== undefined) return _anonClient
  if (!URL || !ANON) {
    console.warn('[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing in env — anon client disabled.')
    _anonClient = null
    return _anonClient
  }
  if (import.meta.env.DEV) {
    console.info('[supabase] creating anon client singleton for URL:', URL)
  }
  _anonClient = createClient(URL, ANON, {
    auth: {
      persistSession: false,
      storageKey: 'sb-anon',
      detectSessionInUrl: false,
      autoRefreshToken: false,
    },
    global: { headers: { 'X-Client-Info': 'bbb/anon' } },
  })
  return _anonClient
}

/**
 * Browser-side admin DB ops intentionally return null here.
 *
 * CRITICAL SECURITY — the SUPABASE_SERVICE_ROLE_KEY is NOT available in the
 * browser bundle. All admin SELECTs / INSERTs / UPDATEs / DELETEs route via
 * the Netlify Function `/api/admin-gateway` (see netlify/functions/admin-gateway.ts)
 * which:
 *   1. Reads SUPABASE_SERVICE_ROLE_KEY from server-only `process.env` (never
 *      shipped to browsers).
 *   2. Verifies the calling browser carries an HMAC-signed AdminSession with a
 *      server-only signing salt (forged localStorage sessions → HTTP 401).
 *   3. Dispatches a whitelist of allowed admin actions (loadLimitsEnsure,
 *      addPromo, saveBanner, etc.) with runtime payload shape validation.
 *
 * Any browser-side code that still tried to use supabaseAdmin() gets a null
 * client and will fail loudly — use adminGateway<T>(action, payload) below
 * instead for ALL admin reads/writes.
 */
export function supabaseAdmin(): SupabaseClient | null {
  return null
}

export type AdminSession = {
  user: string
  issuedAt: number
  expiresAt: number
  signature: string
}

export const ADMIN_SESSION_KEY = 'bbb.admin-session.v1'

export async function adminGateway<T = unknown>(
  action: string,
  payload: unknown = undefined,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const session = (() => {
    try {
      const raw = localStorage.getItem(ADMIN_SESSION_KEY)
      if (!raw) return null
      const s = JSON.parse(raw) as AdminSession
      if (!s || !s.user || !s.signature || typeof s.expiresAt !== 'number') return null
      return s
    } catch {
      return null
    }
  })()
  try {
    const res = await fetch('/api/admin-gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload, session }),
    })
    let json: unknown
    try {
      json = (await res.json()) as unknown
    } catch {
      return { ok: false, error: `HTTP ${res.status} — invalid JSON response.` }
    }
    if (
      !json ||
      typeof json !== 'object' ||
      !('ok' in json) ||
      typeof (json as { ok?: unknown }).ok !== 'boolean'
    ) {
      return { ok: false, error: `HTTP ${res.status} — malformed gateway response.` }
    }
    const shaped = json as
      | { ok: true; data: T }
      | { ok: false; error: string }
    if (shaped.ok) {
      return { ok: true, data: shaped.data }
    }
    return { ok: false, error: shaped.error }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `adminGateway network error: ${msg}` }
  }
}

export type PromoCodeRow = {
  id: number
  code: string
  label: string
  discount_type: 'percent' | 'fixed' | 'unit_price'
  discount_value: number
  is_active: boolean
  max_uses: number | null
  used_count: number
  valid_from: string | null
  valid_until: string | null
  created_at: string
  updated_at: string
}

export type WeeklyLimitsRow = {
  id: number
  week_label: string
  max_brownies: number
  sold_brownies: number
  is_active: boolean
  updated_at: string
  created_at: string
}

export type OrderRow = {
  id: number
  ref: string
  created_at: string
  name: string
  phone: string
  email?: string
  qty: number
  total: number
  subtotal: number
  delivery_fee: number
  discount: number
  method: string
  fulfilment: string
  collection?: string
  address?: string
  promo?: string
  payment_ref?: string
  notes?: string
  status: string
}

export type SalesBannerRow = {
  id: number
  message: string
  is_active: boolean
  start_at: string | null
  end_at: string | null
  created_at: string
  updated_at: string
}

export type CollabEnquiryRow = {
  id: number
  name: string
  company: string | null
  email: string
  phone: string | null
  enquiry_type: 'Corporate / Bulk Order' | 'Brand Collaboration' | 'Other'
  message: string
  replied: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

export type FeedbackSubmissionRow = {
  id: number
  name: string
  contact: string
  feedback: string
  consent_given: boolean
  photo_filename: string | null
  created_at: string
  updated_at: string
}

/** Persist a Corporate / Brand Collab enquiry (CollaboratePage) to Supabase
 * public.collab_enquiries via ANON INSERT policy. Works without admin login
 * (any visitor can submit, no SELECT policy = never publicly readable).
 * Returns the new id (BIGSERIAL) or null on failure. Email + Sheet write are
 * done by the caller separately in parallel.
 */
export async function insertCollabEnquiry(row: {
  name: string
  company?: string | null
  email: string
  phone?: string | null
  enquiry_type: CollabEnquiryRow['enquiry_type']
  message: string
}): Promise<number | null> {
  const sb = supabaseAnon()
  if (!sb) return null
  try {
    const payload = {
      name: (row.name || '').trim(),
      company: (row.company ?? '').trim() || null,
      email: (row.email || '').trim(),
      phone: (row.phone ?? '').trim() || null,
      enquiry_type: row.enquiry_type ?? 'Other',
      message: (row.message || '').trim(),
    }
    const { data, error } = await sb
      .from('collab_enquiries')
      .insert([payload as unknown as Record<string, unknown>])
      .select('id')
      .limit(1)
      .maybeSingle()
    if (error) {
      console.warn('[collab] insertCollabEnquiry failed:', error.message)
      return null
    }
    return (data as { id: number } | null)?.id ?? null
  } catch (e) {
    console.warn('[collab] insertCollabEnquiry error:', e)
    return null
  }
}

/** Persist a feedback submission (FeedbackPage) to Supabase
 * public.feedback_submissions via ANON INSERT policy.
 */
export async function insertFeedbackSubmission(row: {
  name: string
  contact: string
  feedback: string
  consent_given: boolean
  photo_filename?: string | null
}): Promise<number | null> {
  const sb = supabaseAnon()
  if (!sb) return null
  try {
    const payload = {
      name: (row.name || '').trim(),
      contact: (row.contact || '').trim(),
      feedback: (row.feedback || '').trim(),
      consent_given: !!row.consent_given,
      photo_filename: (row.photo_filename ?? '').trim() || null,
    }
    const { data, error } = await sb
      .from('feedback_submissions')
      .insert([payload as unknown as Record<string, unknown>])
      .select('id')
      .limit(1)
      .maybeSingle()
    if (error) {
      console.warn('[feedback] insertFeedbackSubmission failed:', error.message)
      return null
    }
    return (data as { id: number } | null)?.id ?? null
  } catch (e) {
    console.warn('[feedback] insertFeedbackSubmission error:', e)
    return null
  }
}

function adminSignature(payload: string): string {
  const salt = 'bbb-admin-token-v1'
  let hash = 0
  const s = payload + '|' + salt
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i)
    hash |= 0
  }
  return 'h' + (hash >>> 0).toString(16) + (hash * 2654435761 >>> 0).toString(16)
}

export async function verifyAdminLogin(
  username: string,
  password: string,
  hours = 8,
): Promise<boolean> {
  const u = username.trim()
  try {
    const res = await fetch('/api/admin-gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verifyAdminLogin',
        payload: { username: u, password, hours },
        session: null,
      }),
    })
    let json: unknown
    try {
      json = (await res.json()) as unknown
    } catch {
      return false
    }
    if (
      !json ||
      typeof json !== 'object' ||
      !('ok' in json) ||
      typeof (json as { ok?: unknown }).ok !== 'boolean'
    ) {
      console.warn('[admin] verifyAdminLogin: malformed server response')
      return false
    }
    const shaped = json as
      | { ok: true; data: { session: AdminSession } }
      | { ok: false; error: string }
    if (!shaped.ok) {
      console.warn('[admin] verifyAdminLogin rejected:', shaped.error)
      return false
    }
    const sess = shaped.data?.session
    if (!sess || !sess.user || !sess.signature || typeof sess.expiresAt !== 'number') {
      console.warn('[admin] verifyAdminLogin: missing session payload')
      return false
    }
    try {
      localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(sess))
    } catch {
      /* ignore */
    }
    return true
  } catch (e) {
    console.warn('[admin] verifyAdminLogin network error:', e)
    return false
  }
}

export function getAdminSession(): AdminSession | null {
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as AdminSession
    if (!s || !s.user || !s.signature || !s.expiresAt) return null
    if (Date.now() > s.expiresAt) {
      clearAdminSession()
      return null
    }
    const expected = adminSignature(
      s.user + '|' + s.issuedAt + '|' + s.expiresAt,
    )
    if (expected !== s.signature) {
      clearAdminSession()
      return null
    }
    return s
  } catch {
    return null
  }
}

export function setAdminSession(username: string, hours = 8): AdminSession {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + hours * 3600 * 1000
  const session: AdminSession = {
    user: username,
    issuedAt,
    expiresAt,
    signature: adminSignature(username + '|' + issuedAt + '|' + expiresAt),
  }
  try {
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session))
  } catch {
    /* ignore storage errors */
  }
  return session
}

export function clearAdminSession() {
  try {
    localStorage.removeItem(ADMIN_SESSION_KEY)
  } catch {
    /* ignore */
  }
}

export type PromoDef = {
  pct?: number
  fixed?: number
  unit_price?: number
  label: string
}

export async function listActivePromos(): Promise<Record<string, PromoDef>> {
  const sb = supabaseAnon()
  if (!sb) return {}
  try {
    const { data, error } = await sb
      .from('promo_codes')
      .select('code,label,discount_type,discount_value,is_active,valid_from,valid_until,used_count,max_uses')
      .eq('is_active', true)
    if (error || !data) return {}
    const out: Record<string, PromoDef> = {}
    const now = new Date()
    for (const r of data as PromoCodeRow[]) {
      if (r.valid_from && new Date(r.valid_from) > now) continue
      if (r.valid_until && new Date(r.valid_until) < now) continue
      if (r.max_uses != null && r.used_count >= r.max_uses) continue
      const key = r.code.trim().toUpperCase()
      if (r.discount_type === 'fixed') {
        out[key] = { fixed: Number(r.discount_value), label: r.label }
      } else if (r.discount_type === 'unit_price') {
        out[key] = { unit_price: Number(r.discount_value), label: r.label }
      } else {
        out[key] = { pct: Number(r.discount_value), label: r.label }
      }
    }
    return out
  } catch (e) {
    console.warn('[promo] listActivePromos failed:', e)
    return {}
  }
}

export async function getActiveWeeklyLimit(): Promise<{
  max: number
  sold: number
  remaining: number
} | null> {
  const sb = supabaseAnon()
  if (!sb) return null
  try {
    const { data, error } = await sb
      .from('weekly_limits')
      .select('max_brownies,sold_brownies')
      .order('id', { ascending: true })
      .limit(1)
    if (error || !data || data.length === 0) return null
    const r = data[0] as WeeklyLimitsRow
    const max = Number(r.max_brownies) || 0
    const sold = Number(r.sold_brownies) || 0
    return { max, sold, remaining: Math.max(0, max - sold) }
  } catch (e) {
    console.warn('[limits] getActiveWeeklyLimit failed:', e)
    return null
  }
}

export type AdminLimitsDiagnostics = {
  /** how many rows exist right now in weekly_limits table */
  rowCount: number
  /** all rows for debugging */
  rows: WeeklyLimitsRow[]
  /** the row id we target for writes (= lowest id after consolidation) */
  writeId: number | null
  /** true if SERVICE role env var is set */
  hasServiceKey: boolean
  /** true if URL env var is set */
  hasSupabaseUrl: boolean
  /** latest error message from internal calls, if any */
  lastError: string | null
}

/** @deprecated Use adminGateway('loadLimitsEnsure', defaultMax) instead. */
export async function adminEnsureGetWeeklyLimits(
  defaultMax = 100,
  _diagnosticsOut?: { d: AdminLimitsDiagnostics | null },
): Promise<WeeklyLimitsRow | null> {
  void _diagnosticsOut
  const res = await adminGateway<WeeklyLimitsRow | null>('loadLimitsEnsure', defaultMax)
  return res.ok ? res.data : null
}

/** @deprecated Use adminGateway('saveMaxBrownies', { id, max_brownies }) instead. */
export async function adminUpdateMaxBrownies(
  writeId: number,
  newMax: number,
): Promise<{ row: WeeklyLimitsRow | null; error: string | null }> {
  const res = await adminGateway<{ row: WeeklyLimitsRow | null; error: string | null }>('saveMaxBrownies', {
    id: writeId,
    max_brownies: newMax,
  })
  return res.ok ? res.data : { row: null, error: res.error }
}

/** @deprecated Use adminGateway('resetSold', { id }) instead. */
export async function adminResetSoldForNewWeek(
  writeId: number,
): Promise<{ row: WeeklyLimitsRow | null; error: string | null }> {
  const res = await adminGateway<{ row: WeeklyLimitsRow | null; error: string | null }>('resetSold', { id: writeId })
  return res.ok ? res.data : { row: null, error: res.error }
}

/** @deprecated Use adminGateway('deleteOrdersBefore', { beforeIso }) instead. */
export async function adminDeleteOrdersBefore(
  weekStartIso: string,
): Promise<{ deleted: number; error: string | null }> {
  const res = await adminGateway<{ deleted: number; error: string | null }>('deleteOrdersBefore', {
    beforeIso: weekStartIso,
  })
  return res.ok ? res.data : { deleted: 0, error: res.error }
}

export async function insertOrder(row: Omit<OrderRow, 'id' | 'created_at'> & { status: 'paid' | 'shipped' | 'cancelled' }): Promise<string | null> {
  const sb = supabaseAnon()
  if (!sb) return null
  try {
    const payload: Partial<OrderRow> = {
      ref: row.ref,
      name: row.name,
      phone: row.phone,
      email: row.email,
      qty: row.qty,
      total: row.total,
      subtotal: row.subtotal,
      delivery_fee: row.delivery_fee,
      discount: row.discount,
      method: row.method,
      fulfilment: row.fulfilment,
      collection: row.collection,
      address: row.address,
      promo: row.promo,
      payment_ref: row.payment_ref,
      notes: row.notes,
      status: row.status,
    }
    const { error } = await sb.from('orders').insert([payload as OrderRow])
    if (error) {
      console.warn('[order] insertOrder error:', error.message)
      return null
    }
    return payload.ref ?? null
  } catch (e) {
    console.warn('[order] insertOrder failed:', e)
    return null
  }
}

export async function paidConfirmInsertOrder(
  row: Omit<OrderRow, 'id' | 'created_at' | 'status'>,
): Promise<{ ok: boolean; reason: 'ok' | 'no_stock' | 'db_error'; max_cap?: number; new_sold?: number }> {
  const sb = supabaseAnon()
  if (!sb) return { ok: false, reason: 'db_error' }
  const qty = Math.max(0, Math.floor(row.qty ?? 0))
  // STEP 1: Row-locked stock increment (increment_weekly_sold RPC already
  // refuses if sold + qty would exceed max_cap and returns ok=false). Stock
  // increment ONLY happens AFTER confirmed paid Stripe, so failed payments /
  // abandoned carts / cancelled checkout never touch capacity OR create a
  // pending order row.
  try {
    let incrementOk = false
    let max_cap = 0
    let new_sold = 0
    if (qty > 0) {
      const { data, error } = await sb.rpc('increment_weekly_sold', { p_add: qty })
      if (error || !data) {
        return { ok: false, reason: 'db_error' }
      }
      const inc = (data as unknown[])[0] as
        | { new_sold: number; max_cap: number; ok: boolean }
        | undefined
      if (!inc) return { ok: false, reason: 'db_error' }
      incrementOk = !!inc.ok
      max_cap = Number(inc.max_cap) || 0
      new_sold = Number(inc.new_sold) || 0
      if (!incrementOk) {
        return { ok: false, reason: 'no_stock', max_cap, new_sold }
      }
    }
    // STEP 2: Insert the order AS paid — we NEVER write a pending status. The
    // status column exists only for RLS / admin marking later.
    const ref = await insertOrder({ ...row, status: 'paid' })
    if (!ref) {
      return { ok: false, reason: 'db_error', max_cap, new_sold }
    }
    return { ok: true, reason: 'ok', max_cap, new_sold }
  } catch (e) {
    console.warn('[order] paidConfirmInsertOrder failed:', e)
    return { ok: false, reason: 'db_error' }
  }
}

export type ActiveBanner = {
  message: string
  start_at: string | null
  end_at: string | null
}

export type BannerResult =
  | { kind: 'show'; message: string; start_at: string | null; end_at: string | null }
  | { kind: 'hidden' }
  | { kind: 'error' }

/**
 * Storefront helper — reads the banner row (id=1, RLS now allows reading it
 * regardless of is_active flag). Returns a tri-state so the caller can
 * distinguish:
 *   'show'   — active flag is TRUE AND current time is inside the optional
 *              start/end window. Safe to render.
 *   'hidden' — DB row was returned successfully but either is_active=FALSE
 *              OR we are outside start_at/end_at window. In this case the
 *              caller MUST NOT fall back to the hardcoded default banner,
 *              because Portia explicitly turned it off.
 *   'error'  — genuine SQL/network/RLS failure against Supabase. Caller
 *              SHOULD fall back to the hardcoded default banner so the shop
 *              never goes dark on transient infra issues.
 *
 * Picks id=1 first (single-row of truth). Logs every decision to DevTools so
 * admins debugging "banner doesn't show" reports can pinpoint the exact cause.
 */
export async function getActiveBanner(): Promise<BannerResult> {
  const sb = supabaseAnon()
  if (!sb) {
    console.warn('[banner] getActiveBanner: supabaseAnon() returned null (VITE_SUPABASE_ANON_KEY missing?)')
    return { kind: 'error' }
  }
  try {
    const { data, error } = await sb
      .from('sales_banners')
      .select('id,message,is_active,start_at,end_at,updated_at')
      .order('updated_at', { ascending: false })
    if (error) {
      console.warn('[banner] getActiveBanner SQL error:', error.message, error)
      return { kind: 'error' }
    }
    const rows = (data as Array<{
      id: number
      message: string
      is_active: boolean
      start_at: string | null
      end_at: string | null
      updated_at: string
    }> | null) ?? []
    if (rows.length === 0) {
      console.warn('[banner] getActiveBanner: 0 rows in sales_banners → error fallback.')
      return { kind: 'error' }
    }
    const now = Date.now()
    const why = (r: typeof rows[number]) =>
      `id=${r.id} is_active=${r.is_active} start_at=${r.start_at ?? 'null'} end_at=${r.end_at ?? 'null'} updated=${r.updated_at} msg=${JSON.stringify(r.message.slice(0, 40))}`
    // Priority 1: id=1 specifically — guarantees "single row of truth" model.
    const id1 = rows.find((r) => Number(r.id) === 1)
    if (id1) {
      if (import.meta.env.DEV) console.info('[banner] evaluating id=1 primary row:', why(id1))
      if (!id1.is_active) {
        if (import.meta.env.DEV) console.info('[banner] id=1 is_active=FALSE → hidden (admin turned it off).')
        return { kind: 'hidden' }
      }
      if (id1.start_at && new Date(id1.start_at).getTime() > now) {
        if (import.meta.env.DEV) {
          console.info(
            '[banner] id=1 start_at future → hidden until ' +
              new Date(id1.start_at).toLocaleString() +
              ' (now=' + new Date(now).toLocaleString() + ').',
          )
        }
        return { kind: 'hidden' }
      }
      if (id1.end_at && new Date(id1.end_at).getTime() < now) {
        if (import.meta.env.DEV) {
          console.info(
            '[banner] id=1 end_at past → hidden since ' +
              new Date(id1.end_at).toLocaleString() +
              ' (now=' + new Date(now).toLocaleString() + ').',
          )
        }
        return { kind: 'hidden' }
      }
      if (import.meta.env.DEV) console.info('[banner] id=1 active + in window → SHOW.')
      return { kind: 'show', message: id1.message, start_at: id1.start_at, end_at: id1.end_at }
    }
    // Priority 2 (fallback): most recently updated active row in window.
    if (import.meta.env.DEV) console.warn('[banner] id=1 missing — scanning ' + String(rows.length) + ' row(s) as fallback.')
    for (const row of rows) {
      if (!row.is_active) continue
      if (row.start_at && new Date(row.start_at).getTime() > now) continue
      if (row.end_at && new Date(row.end_at).getTime() < now) continue
      if (import.meta.env.DEV) console.info('[banner] fallback id=' + String(row.id) + ' → SHOW:', why(row))
      return { kind: 'show', message: row.message, start_at: row.start_at, end_at: row.end_at }
    }
    if (import.meta.env.DEV) console.info('[banner] no id=1 and no fallback rows qualify → hidden.')
    return { kind: 'hidden' }
  } catch (e) {
    console.warn('[banner] getActiveBanner failed:', e)
    return { kind: 'error' }
  }
}

/** @deprecated Use adminGateway('loadBanner') instead. */
export async function adminGetBanner(): Promise<SalesBannerRow | null> {
  const res = await adminGateway<SalesBannerRow | null>('loadBanner')
  return res.ok ? res.data : null
}

type AdminBannerPatch = {
  message: string
  is_active: boolean
  start_at: string | null
  end_at: string | null
}
/** @deprecated Use adminGateway('saveBanner', patch) instead. */
export async function adminSaveBanner(patch: AdminBannerPatch): Promise<SalesBannerRow | null> {
  const res = await adminGateway<SalesBannerRow | null>('saveBanner', patch)
  if (!res.ok) {
    console.warn('[banner] adminSaveBanner failed:', res.error)
    return null
  }
  if (import.meta.env.DEV) console.info('[banner] adminSaveBanner success — saved row:', res.data)
  return res.data
}
