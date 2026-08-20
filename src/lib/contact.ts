import { BBB } from './bbbConfig'

export type ContactFormPayload =
  | {
      kind: 'collab'
      name: string
      company?: string | null
      email: string
      phone?: string | null
      enquiry_type: 'Corporate / Bulk Order' | 'Brand Collaboration' | 'Other'
      message: string
    }
  | {
      kind: 'feedback'
      name: string
      telegram_handle: string
      feedback: string
      consent_given: boolean
      photo_filename?: string | null
    }

export type ContactSendResult = {
  ok: boolean
  transport: 'http'
  /** raw response text or parsed JSON error */
  detail: string
  /** true when VITE_CONTACT_ENDPOINT is missing/invalid — site owner config issue */
  misconfigured?: boolean
}

/** Returns the configured direct-AJAX email POST endpoint (Formspree-style)
 * or null if not set.  We do NOT fall back to mailto: anymore per owner req.
 * Use HTTPS POST only; plaintext contact endpoint is rejected.
 */
export function contactEndpointConfigured(): string | null {
  const raw = (import.meta.env.VITE_CONTACT_ENDPOINT as string | undefined) ?? ''
  const url = raw.trim()
  if (!url) return null
  if (!/^https:\/\//i.test(url)) {
    console.warn(
      '[contact] VITE_CONTACT_ENDPOINT must be a https:// URL for CORS to work. Found:',
      url,
    )
    return null
  }
  return url
}

function collabSubject(p: Extract<ContactFormPayload, { kind: 'collab' }>): string {
  const tag =
    p.enquiry_type === 'Brand Collaboration'
      ? 'Brand collab'
      : p.enquiry_type === 'Other'
        ? 'General enquiry'
        : 'Corporate / bulk order'
  return `[Built By Bakes] ${tag} from ${p.name}`
}

function feedbackSubject(p: Extract<ContactFormPayload, { kind: 'feedback' }>): string {
  return `[Built By Bakes] Feedback from ${p.name}`
}

function collabBody(p: Extract<ContactFormPayload, { kind: 'collab' }>): string {
  return [
    `Name: ${p.name}`,
    `Company: ${p.company || '—'}`,
    `Email: ${p.email}`,
    `Phone: ${p.phone || '—'}`,
    `Type: ${p.enquiry_type}`,
    '',
    'Message:',
    p.message || '(empty)',
    '',
    `Submitted: ${new Date().toString()} (SG time +8h)`,
  ].join('\n')
}

function feedbackBody(p: Extract<ContactFormPayload, { kind: 'feedback' }>): string {
  return [
    `Name: ${p.name}`,
    `Telegram: ${p.telegram_handle}`,
    `Consent to share: ${p.consent_given ? 'Yes' : 'No'}`,
    p.photo_filename ? `Photo: ${p.photo_filename}` : 'Photo: (none)',
    '',
    'Feedback:',
    p.feedback || '(empty)',
    '',
    `Submitted: ${new Date().toString()} (SG time +8h)`,
  ].join('\n')
}

/** POST enquiry/feedback directly to VITE_CONTACT_ENDPOINT (Formspree style).
 * Endpoint MUST be an HTTPS URL that accepts JSON POST and returns JSON.
 * Popular options include:
 *   • Formspree (free tier 50/mo) — https://formspree.io/f/{YOUR_FORM_ID}
 *       → set the form's "To" address to builtbybakes.sg@gmail.com
 *   • Netlify Forms (free tier 100/mo) — automatic if hosted on Netlify
 *   • EmailJS / Resend AJAX proxy / custom serverless function
 *
 * No Supabase, no Google Sheet, no mailto fallback: per owner explicit request.
 */
export async function sendContactForm(
  payload: ContactFormPayload,
): Promise<ContactSendResult> {
  const url = contactEndpointConfigured()
  if (!url) {
    return {
      ok: false,
      transport: 'http',
      detail:
        'VITE_CONTACT_ENDPOINT is not configured in .env (or is not a https:// URL). ' +
        'Please set VITE_CONTACT_ENDPOINT=https://formspree.io/f/YOUR_FORM_ID ' +
        '(or similar Formspree-style endpoint) so enquiries can be emailed directly to ' +
        BBB.CORP_EMAIL +
        ' without opening the mail app.',
      misconfigured: true,
    }
  }

  let body: Record<string, unknown>
  if (payload.kind === 'collab') {
    body = {
      // Formspree convention: _subject overrides email subject line
      _subject: collabSubject(payload),
      _to: BBB.CORP_EMAIL,
      _replyto: payload.email,
      // EmailJS / Resend convention: recipient + from name
      to: BBB.CORP_EMAIL,
      from_name: payload.name,
      from_email: payload.email,
      reply_to: payload.email,
      name: payload.name,
      company: payload.company || '',
      email: payload.email,
      phone: payload.phone || '',
      enquiry_type: payload.enquiry_type,
      message: payload.message,
      plain_body: collabBody(payload),
    }
  } else {
    body = {
      _subject: feedbackSubject(payload),
      _to: BBB.CORP_EMAIL,
      _replyto: BBB.CORP_EMAIL,
      to: BBB.CORP_EMAIL,
      from_name: payload.name,
      from_email: BBB.CORP_EMAIL,
      reply_to: BBB.CORP_EMAIL,
      name: payload.name,
      telegram_handle: payload.telegram_handle,
      consent_given: payload.consent_given,
      photo_filename: payload.photo_filename || '',
      feedback: payload.feedback,
      plain_body: feedbackBody(payload),
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text().catch(() => '')
    if (res.ok) {
      return {
        ok: true,
        transport: 'http',
        detail:
          text ||
          'Sent directly to ' +
            BBB.CORP_EMAIL +
            ' — we will reply within 2–3 business days.',
      }
    }
    // Try to extract Formspree/EmailJS-style errors object
    let msg = ''
    try {
      const j = JSON.parse(text)
      if (j && Array.isArray(j.errors)) {
        msg = j.errors
          .map((e: { message?: string; code?: string }) => `${e.code || ''} ${e.message || ''}`.trim())
          .join('; ')
      } else if (j && typeof j.error === 'string') {
        msg = j.error
      } else if (j && typeof j.message === 'string') {
        msg = j.message
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      transport: 'http',
      detail: `HTTP ${res.status} ${res.statusText}${msg ? ' — ' + msg : ' — ' + text}`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      transport: 'http',
      detail:
        'Network error connecting to VITE_CONTACT_ENDPOINT — check CORS or URL. ' +
        'Underlying: ' +
        msg,
    }
  }
}
