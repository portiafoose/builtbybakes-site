import * as XLSX from 'xlsx'
import type { OrderRow } from './supabase'

// ========== Week helpers (Singapore timezone, Thursday reset) =================
//
// Built By Bakes weekly reset cadence:
//   * Drop opens Friday evening for the coming bake batch
//   * Close Tuesday night
//   * Collection Thursday 7pm → weekly sold/limits reset on Thursday.
// So the "reporting week" that admins want to export is:
//   Thursday 00:00:00 SG time → next Wednesday 23:59:59 SG time (inclusive).
// Orders inside this window are tagged the same "week" and that's the
// default range offered on the admin Orders download button.

const SG_OFFSET_MS = 8 * 60 * 60 * 1000

function toSgDate(utcInstantMs: number): Date {
  // Pretend UTC is SG time so day/month math uses the SG calendar wall-clock.
  return new Date(utcInstantMs + SG_OFFSET_MS)
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sgDateFromYmd(ymdStr: string, endOfDay = false): number {
  const [y, m, d] = ymdStr.split('-').map((n) => Number(n))
  const base = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0)
  const sgMidnightUtcMs = base - SG_OFFSET_MS
  if (endOfDay) return sgMidnightUtcMs + 24 * 60 * 60 * 1000 - 1
  return sgMidnightUtcMs
}

/**
 * Thursday-start, Wednesday-end Singapore "order week" containing `refMs`.
 * Returns `{ startMs, endMs, startYmd, endYmd, weekLabel }`.
 */
export function bbbWeekContaining(refMs: number = Date.now()): {
  startMs: number
  endMs: number
  startYmd: string
  endYmd: string
  weekLabel: string
} {
  const sg = toSgDate(refMs)
  const dow = sg.getUTCDay() // 0=Sun … 4=Thu … 6=Sat

  // Days back to the Thursday that started THIS week:
  //   Thu (4) → 0 back
  //   Fri (5) → 1 day back
  //   Sat (6) → 2 back
  //   Sun (0) → 3 back
  //   Mon (1) → 4 back
  //   Tue (2) → 5 back
  //   Wed (3) → 6 back
  const daysBack = (dow + 3) % 7
  const thuStart = new Date(Date.UTC(sg.getUTCFullYear(), sg.getUTCMonth(), sg.getUTCDate() - daysBack, 0, 0, 0))
  const thuStartSgUtcMs = thuStart.getTime() - SG_OFFSET_MS

  // End = next Wednesday 23:59:59 SG (start + 7 days - 1 ms)
  const wedEndSgUtcMs = thuStartSgUtcMs + 7 * 24 * 60 * 60 * 1000 - 1

  const startYmd = ymd(toSgDate(thuStartSgUtcMs))
  const endYmd = ymd(toSgDate(wedEndSgUtcMs))
  return {
    startMs: thuStartSgUtcMs,
    endMs: wedEndSgUtcMs,
    startYmd,
    endYmd,
    weekLabel: `Week ${startYmd} → ${endYmd} (Singapore, Thu→Wed)`,
  }
}

export type OrderExportRange = {
  startYmd: string | null
  endYmd: string | null
}

export function ordersInRange(rows: OrderRow[], range: OrderExportRange): OrderRow[] {
  if (!rows || rows.length === 0) return []
  const startCut = range.startYmd ? sgDateFromYmd(range.startYmd, false) : -Infinity
  const endCut = range.endYmd ? sgDateFromYmd(range.endYmd, true) : Infinity
  return rows.filter((o) => {
    const t = typeof o.created_at === 'string' ? new Date(o.created_at).getTime() : NaN
    return Number.isFinite(t) && t >= startCut && t <= endCut
  })
}

// ========== Excel / OpenDocument export ======================================
//
// xlsx (SheetJS CE) writes .xlsx directly in the browser — no server needed.
// Admin can open the file with Excel, Google Sheets, LibreOffice, or Numbers.

const EXPORT_COLUMNS: Array<{
  key: string
  label: string
  width: number
  format?: (row: OrderRow) => string | number | boolean | null | undefined
}> = [
  { key: 'ref', label: 'Order Ref', width: 14 },
  { key: 'created_at', label: 'Placed (SG time)', width: 22, format: (r) => {
      const t = typeof r.created_at === 'string' ? new Date(r.created_at).getTime() : NaN
      if (!Number.isFinite(t)) return ''
      return new Date(t + SG_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19)
    } },
  { key: 'name', label: 'Name', width: 22 },
  { key: 'phone', label: 'Phone', width: 16 },
  { key: 'email', label: 'Email', width: 28 },
  { key: 'qty', label: 'Qty (brownies)', width: 10, format: (r) => Number(r.qty) },
  { key: 'method', label: 'Payment Method', width: 14 },
  { key: 'status', label: 'Status', width: 12 },
  { key: 'fulfilment', label: 'Fulfilment', width: 14 },
  { key: 'collection', label: 'Collection / Delivery Window', width: 36, format: (r) =>
      r.fulfilment === 'Delivery'
        ? r.address || 'Delivery — address missing'
        : r.collection || r.fulfilment },
  { key: 'address', label: 'Delivery Address', width: 40, format: (r) =>
      r.fulfilment === 'Delivery' ? r.address || '' : '' },
  { key: 'subtotal', label: 'Subtotal (SGD)', width: 14, format: (r) => Number(r.subtotal) },
  { key: 'delivery_fee', label: 'Delivery Fee (SGD)', width: 16, format: (r) => Number(r.delivery_fee) },
  { key: 'discount', label: 'Discount (SGD)', width: 14, format: (r) => Number(r.discount) },
  { key: 'total', label: 'Total Paid (SGD)', width: 16, format: (r) => Number(r.total) },
  { key: 'promo', label: 'Promo Code', width: 20, format: (r) => r.promo || '' },
  { key: 'payment_ref', label: 'Stripe Session / PI ID', width: 38, format: (r) => r.payment_ref || '' },
  { key: 'notes', label: 'Customer Notes', width: 50, format: (r) => r.notes || '' },
]

/**
 * Download an Excel (.xlsx) workbook for the given orders.
 *   - Sheet 1 name: "Orders"
 *   - Row 1: bold header labels (via s/!cols widths + header row)
 *   - Currency columns formatted as numbers (Excel user can change cell format to Accounting/SGD if desired)
 *   - Filename: built-by-bakes-orders-YYYYMMDD-YYYYMMDD.xlsx (period from range if available)
 */
export function downloadOrdersExcel(rows: OrderRow[], range?: OrderExportRange & { weekLabel?: string }): void {
  const header = EXPORT_COLUMNS.map((c) => c.label)
  const body: Array<Array<string | number | boolean | null | undefined>> = rows.map((r) =>
    EXPORT_COLUMNS.map((c) => {
      const raw = c.format ? c.format(r) : ((r as unknown as Record<string, unknown>)[c.key] ?? '')
      if (raw == null) return raw as null | undefined
      if (['string', 'number', 'boolean'].includes(typeof raw)) return raw as string | number | boolean
      return String(raw)
    }),
  )
  const aoa = [header, ...body]

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Column widths (approx characters)
  ws['!cols'] = EXPORT_COLUMNS.map((c) => ({ wch: c.width }))

  // Freeze top header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Orders')

  // Filename
  const tag =
    range?.startYmd && range?.endYmd
      ? `${range.startYmd.replaceAll('-', '')}-${range.endYmd.replaceAll('-', '')}`
      : 'all'
  const stamp = new Date(Date.now() + SG_OFFSET_MS).toISOString().slice(0, 10).replaceAll('-', '')
  const filename = `built-by-bakes-orders-${tag}-exported-${stamp}.xlsx`

  XLSX.writeFile(wb, filename)
}
