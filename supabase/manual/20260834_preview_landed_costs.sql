-- 20260834_preview_landed_costs.sql
-- Read-only. Shows what receiving each vendor invoice WOULD cost the stock.
-- Writes nothing, receives nothing, changes nothing.
--
-- ═══ What this is for ════════════════════════════════════════════════════════
--
-- 20260794 added landed costing but nothing has been received through it yet,
-- so the arithmetic has never met real data. This runs the real function —
-- rma_vi_landed_unit_costs, the same one receive_vendor_invoice calls — against
-- every invoice that could still be received, and puts its answer next to the
-- inputs so it can be checked by hand.
--
-- The `check_by_hand` column is the sum the answer should match. If the two
-- disagree the function is wrong, and it is better to find that here than in
-- the cost of thirty motherboards.

WITH vi AS (
  SELECT
    v.id,
    COALESCE(v.vi_code, '(not yet coded)') AS code,
    b.brand_name                           AS vendor,
    v.status,
    v.currency,
    v.exchange_rate,
    (SELECT COALESCE(SUM(amount), 0)
       FROM public.vendor_invoice_charges c
      WHERE c.vendor_invoice_id = v.id)    AS charges,
    l.line
  FROM public.vendor_invoices v
  LEFT JOIN public.brands b ON b.id = v.vendor_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.line_items, '[]'::jsonb)) AS l(line)
  WHERE v.status IN ('draft', 'pending_approval', 'approved', 'partially_received')
)
SELECT
  vi.code,
  vi.vendor,
  vi.status,
  vi.currency,
  vi.exchange_rate,
  left(vi.line->>'product_name', 40)                       AS product,
  (vi.line->>'qty_ordered')::numeric                       AS qty,
  (vi.line->>'unit_cost')::numeric                         AS unit_cost,
  COALESCE((vi.line->>'discount_pct')::numeric, 0)         AS disc_pct,
  vi.charges,

  -- What the database will actually write onto the stock.
  (SELECT c.unit_cost_base
     FROM public.rma_vi_landed_unit_costs(vi.id) c
    WHERE c.product_id = (vi.line->>'product_id')::uuid
    LIMIT 1)                                               AS unit_cost_base,

  -- The same figure worked out independently, ignoring charges. With no
  -- charges on the invoice these two must be equal; with charges the function
  -- must come out HIGHER by the line's share of them.
  round(
    (vi.line->>'unit_cost')::numeric
    * (1 - COALESCE((vi.line->>'discount_pct')::numeric, 0) / 100)
    * COALESCE(vi.exchange_rate, 1), 4)                    AS check_by_hand,

  CASE
    WHEN vi.currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                          WHERE config_key = 'default_currency')
     AND vi.exchange_rate = 1
      THEN '*** RATE MISSING — this cost is understated by the exchange rate ***'
    WHEN vi.charges > 0 THEN 'includes a share of ' || vi.charges || ' in charges'
    ELSE 'no charges; should equal check_by_hand exactly'
  END                                                      AS note

FROM vi
ORDER BY vi.code, product;

-- ─────────────────────────────────────────────────────────────────────────────
-- Second view: what stock currently has NO known cost. Expect this to be
-- everything already in the warehouses — costing starts from the next receipt,
-- and a zero here means UNKNOWN, not free. Stage 5 must report it that way
-- rather than as a 100% margin.
--
--   SELECT w.warehouse_id, p.product_name, w.quantity,
--          w.total_cost_base, w.avg_cost_base,
--          CASE WHEN w.quantity > 0 AND w.total_cost_base = 0
--               THEN 'COST UNKNOWN' ELSE 'costed' END AS state
--     FROM public.warehouse_stock w
--     JOIN public.products p ON p.id = w.product_id
--    WHERE w.quantity > 0
--    ORDER BY state, p.product_name;
