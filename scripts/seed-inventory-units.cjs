const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  'https://ohkynosgscfygtjxbpxq.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'REPLACE_WITH_SERVICE_ROLE_KEY'
)

async function main() {
  // Clear existing units
  console.log('Clearing inventory_units...')
  await supabase.from('inventory_units').delete().neq('id', '00000000-0000-0000-0000-000000000000')

  // Fetch all tickets
  console.log('Fetching tickets...')
  const { data: tickets, error } = await supabase
    .from('rma_tickets')
    .select('id, rma_number, ticket_status, products, created_date')

  if (error) { console.error('Failed to fetch tickets:', error.message); process.exit(1) }
  console.log(`  Found ${tickets.length} tickets`)

  const units = []
  for (const ticket of tickets) {
    if (ticket.ticket_status === 'Cancelled') continue
    const products = Array.isArray(ticket.products) ? ticket.products : []
    for (const prod of products) {
      const invStatus = {
        'Received':     'active_rma',
        'Under Repair': 'active_rma',
        'Repaired':     'active_rma',
        "Can't Repair": 'company_stock',
        'Replacement':  'company_stock',
        'Credit Note':  'company_stock',
      }[prod.product_status] || 'active_rma'

      units.push({
        rma_ticket_id:   ticket.id,
        rma_number:      ticket.rma_number,
        product_name:    prod.product_name || 'Unknown',
        serial_number:   prod.serial_number || null,
        warranty_status: prod.warranty_status || null,
        status:          invStatus,
        resolution_type: invStatus === 'company_stock'
          ? prod.product_status.toLowerCase().replace(/[^a-z]/g, '_').replace(/_+/g, '_')
          : null,
        notes: null,
        created_date: ticket.created_date || new Date().toISOString(),
      })
    }
  }

  console.log(`\nInserting ${units.length} inventory units...`)
  const BATCH = 25
  let inserted = 0
  for (let b = 0; b < units.length; b += BATCH) {
    const { error: iErr } = await supabase.from('inventory_units').insert(units.slice(b, b + BATCH))
    if (iErr) { console.error(`Batch error:`, iErr.message); process.exit(1) }
    inserted += Math.min(BATCH, units.length - b)
    process.stdout.write(`  ${inserted}/${units.length}\r`)
  }

  console.log(`\nDone! Inserted ${units.length} inventory units.`)

  // Quick stats
  const byStatus = {}
  for (const u of units) byStatus[u.status] = (byStatus[u.status] || 0) + 1
  console.log('By status:', byStatus)
}

main().catch(err => { console.error(err); process.exit(1) })
