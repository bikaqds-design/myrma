const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = 'https://ohkynosgscfygtjxbpxq.supabase.co'
// Use the service_role key (from Supabase dashboard → Settings → API) to bypass RLS
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'REPLACE_WITH_SERVICE_ROLE_KEY'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Seed data ────────────────────────────────────────────────────────────────

const SEED_BRANDS = [
  { brand_name: 'Dell' },
  { brand_name: 'HP' },
  { brand_name: 'Lenovo' },
  { brand_name: 'Apple' },
  { brand_name: 'Cisco' },
  { brand_name: 'Samsung' },
]

// { brand: brandName, category: categoryName, subcategories: [...] }
const SEED_CATALOG = [
  { brand: 'Dell',   category: 'Laptops',        subcategories: ['Inspiron', 'Latitude', 'XPS', 'Precision'] },
  { brand: 'Dell',   category: 'Desktops',        subcategories: ['OptiPlex', 'Vostro', 'Tower'] },
  { brand: 'HP',     category: 'Laptops',        subcategories: ['EliteBook', 'ProBook', 'Spectre', 'Pavilion'] },
  { brand: 'HP',     category: 'Printers',       subcategories: ['LaserJet', 'OfficeJet', 'DeskJet'] },
  { brand: 'Lenovo', category: 'Laptops',        subcategories: ['ThinkPad', 'IdeaPad', 'Legion'] },
  { brand: 'Lenovo', category: 'Desktops',       subcategories: ['ThinkCentre', 'IdeaCentre'] },
  { brand: 'Apple',  category: 'Laptops',        subcategories: ['MacBook Air', 'MacBook Pro'] },
  { brand: 'Apple',  category: 'Tablets',        subcategories: ['iPad Pro', 'iPad Air', 'iPad mini'] },
  { brand: 'Cisco',  category: 'Networking',     subcategories: ['Switches', 'Routers', 'Firewalls', 'Access Points'] },
  { brand: 'Samsung', category: 'Monitors',      subcategories: ['Curved', 'Flat', 'UltraWide'] },
]

// One product per subcategory
const PRODUCT_NAMES = {
  'Inspiron':      'Dell Inspiron 15 3000',
  'Latitude':      'Dell Latitude 5540',
  'XPS':           'Dell XPS 15 9530',
  'Precision':     'Dell Precision 5570',
  'OptiPlex':      'Dell OptiPlex 7010',
  'Vostro':        'Dell Vostro 3910',
  'Tower':         'Dell Tower 5000',
  'EliteBook':     'HP EliteBook 840 G10',
  'ProBook':       'HP ProBook 450 G10',
  'Spectre':       'HP Spectre x360',
  'Pavilion':      'HP Pavilion 15',
  'LaserJet':      'HP LaserJet Pro M404dn',
  'OfficeJet':     'HP OfficeJet Pro 9015e',
  'DeskJet':       'HP DeskJet 2755e',
  'ThinkPad':      'Lenovo ThinkPad X1 Carbon',
  'IdeaPad':       'Lenovo IdeaPad 5 Pro',
  'Legion':        'Lenovo Legion 5i',
  'ThinkCentre':   'Lenovo ThinkCentre M70q',
  'IdeaCentre':    'Lenovo IdeaCentre AIO 5i',
  'MacBook Air':   'Apple MacBook Air M2',
  'MacBook Pro':   'Apple MacBook Pro 14"',
  'iPad Pro':      'Apple iPad Pro 12.9"',
  'iPad Air':      'Apple iPad Air 5th Gen',
  'iPad mini':     'Apple iPad mini 6th Gen',
  'Switches':      'Cisco Catalyst 1000',
  'Routers':       'Cisco ISR 4321',
  'Firewalls':     'Cisco Firepower 1010',
  'Access Points': 'Cisco Aironet 2800',
  'Curved':        'Samsung 27" Curved Monitor',
  'Flat':          'Samsung 24" Flat Monitor',
  'UltraWide':     'Samsung 34" UltraWide Monitor',
}

const B2B_CUSTOMERS = [
  { contact_person: 'Ahmed Al-Rashid',    company_name: 'Gulf Tech Solutions',      mobile: '+971-50-1234567', email: 'ahmed@gulftech.ae',      address: 'Dubai Media City, Dubai' },
  { contact_person: 'Sara Mohammed',      company_name: 'Emirates IT Group',        mobile: '+971-52-2345678', email: 'sara@emiratesit.ae',      address: 'DIFC, Dubai' },
  { contact_person: 'Khalid Bin Salman',  company_name: 'Al Noor Trading Co.',      mobile: '+971-55-3456789', email: 'khalid@alnoor.ae',        address: 'Sharjah Industrial, Sharjah' },
  { contact_person: 'Fatima Al-Zaabi',    company_name: 'Horizon Digital LLC',      mobile: '+971-56-4567890', email: 'fatima@horizondig.ae',    address: 'Abu Dhabi Global Market' },
  { contact_person: 'Omar Hassan',        company_name: 'Delta Systems UAE',        mobile: '+971-50-5678901', email: 'omar@deltasys.ae',        address: 'Jebel Ali Free Zone' },
  { contact_person: 'Mona Al-Farsi',      company_name: 'Blue Sky Technology',      mobile: '+971-54-6789012', email: 'mona@blueskytec.ae',      address: 'Hamdan Street, Abu Dhabi' },
  { contact_person: 'Tariq Mahmoud',      company_name: 'Phoenix IT Services',      mobile: '+971-52-7890123', email: 'tariq@phoenixit.ae',      address: 'Business Bay, Dubai' },
  { contact_person: 'Rania Al-Ameri',     company_name: 'Summit Solutions FZE',     mobile: '+971-55-8901234', email: 'rania@summitsol.ae',      address: 'Ras Al Khaimah FTZ' },
  { contact_person: 'Faisal Al-Qassim',  company_name: 'Nexus Computing LLC',      mobile: '+971-50-9012345', email: 'faisal@nexuscomp.ae',     address: 'Deira, Dubai' },
  { contact_person: 'Layla Ibrahim',      company_name: 'Stellar Networks',         mobile: '+971-56-0123456', email: 'layla@stellarnet.ae',     address: 'Corniche, Abu Dhabi' },
]

const B2C_CUSTOMERS = [
  { contact_person: 'Mohammed Al-Mansoori', mobile: '+971-50-1112222', email: 'moh.almansoori@gmail.com',  address: 'Mirdif, Dubai' },
  { contact_person: 'Aisha Al-Blooshi',     mobile: '+971-52-2223333', email: 'aisha.blooshi@hotmail.com', address: 'Al Ain, Abu Dhabi' },
  { contact_person: 'Yousuf Khalil',        mobile: '+971-55-3334444', email: 'ykhalil@yahoo.com',         address: 'Bur Dubai, Dubai' },
  { contact_person: 'Noura Al-Ketbi',       mobile: '+971-56-4445555', email: 'noura.ketbi@gmail.com',     address: 'Sharjah City' },
  { contact_person: 'Hassan Al-Mazrouei',   mobile: '+971-50-5556666', email: 'h.mazrouei@gmail.com',      address: 'Musaffah, Abu Dhabi' },
  { contact_person: 'Mariam Saeed',         mobile: '+971-54-6667777', email: 'mariam.saeed@outlook.com',  address: 'Jumeirah, Dubai' },
  { contact_person: 'Saeed Al-Dhaheri',     mobile: '+971-52-7778888', email: 'saeed.dhaheri@gmail.com',   address: 'Ajman City' },
  { contact_person: 'Hessa Al-Nuaimi',      mobile: '+971-55-8889999', email: 'hessa.nuaimi@gmail.com',    address: 'Khalidiyah, Abu Dhabi' },
  { contact_person: 'Rashid Al-Shamsi',     mobile: '+971-50-9990000', email: 'rashid.shamsi@hotmail.com', address: 'Al Qusais, Dubai' },
  { contact_person: 'Dana Al-Suwaidi',      mobile: '+971-56-0001111', email: 'dana.suwaidi@gmail.com',    address: 'Yas Island, Abu Dhabi' },
]

const ISSUES = [
  'Unit not powering on after normal use',
  'Screen flickering / display issues',
  'Battery not holding charge',
  'Overheating and shutting down unexpectedly',
  'Physical damage — cracked screen',
  'Keyboard keys not responding',
  'Touchpad malfunction',
  'Wi-Fi / Bluetooth connectivity issues',
  'Hard drive making clicking noise',
  'USB ports not detected',
  'Fan noise / cooling system issue',
  'Software corruption after update',
  'Camera not working',
  'Audio output failure',
  'Power adapter port damaged',
  'Unit dropped — physical damage',
  'Water damage',
  'Slow performance / hanging',
  'BIOS failure — not booting',
  'Paper jam / print quality issue',
  'Toner cartridge error',
  'Network port not responding',
  'Touch screen not calibrating',
  'Device not recognized by system',
]

const TICKET_STATUSES = ['New', 'In Progress', 'On Hold', 'Completed', 'Cancelled']
const PRIORITIES      = ['Low', 'Medium', 'High', 'Critical']

const PRODUCT_STATUSES_BY_TICKET = {
  'New':         ['Received'],
  'In Progress': ['Received', 'Under Repair', 'Under Repair'],
  'On Hold':     ['Received', 'Under Repair'],
  'Completed':   ['Repaired', 'Replacement', 'Credit Note', 'Repaired', 'Repaired'],
  'Cancelled':   ['Received', "Can't Repair"],
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

function makeRMANumber(index, dayOffset) {
  const d = new Date()
  d.setDate(d.getDate() - dayOffset)
  const yy = String(d.getFullYear()).slice(2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `RMA-${yy}${mm}${dd}-${String(index).padStart(4, '0')}`
}

function pickProductCount() {
  const r = Math.random()
  if (r < 0.55) return 1
  if (r < 0.80) return 2
  if (r < 0.93) return 3
  return 4
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Clear existing data ──────────────────────────────────────────────
  console.log('Clearing existing data...')
  const clearTables = ['inventory_units', 'manufacturer_batches', 'ticket_activity', 'ticket_comments', 'rma_tickets', 'products', 'subcategories', 'categories', 'customers', 'brands']
  for (const table of clearTables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (error && error.code !== '42P01') console.warn(`  Warning clearing ${table}: ${error.message}`)
    else console.log(`  Cleared ${table}`)
  }

  // ── 2. Insert brands ────────────────────────────────────────────────────
  console.log('\nInserting brands...')
  const { data: brands, error: bErr } = await supabase.from('brands').insert(SEED_BRANDS).select()
  if (bErr) { console.error('Brands insert failed:', bErr.message); process.exit(1) }
  const brandMap = {} // brand_name → id
  for (const b of brands) brandMap[b.brand_name] = b.id
  console.log(`  Inserted ${brands.length} brands`)

  // ── 3. Insert categories ────────────────────────────────────────────────
  console.log('Inserting categories...')
  const catPayloads = SEED_CATALOG.map(c => ({ category_name: c.category, brand_id: brandMap[c.brand] }))
  const uniqueCats = []
  const seenCats = new Set()
  for (const c of catPayloads) {
    const key = `${c.brand_id}-${c.category_name}`
    if (!seenCats.has(key)) { seenCats.add(key); uniqueCats.push(c) }
  }
  const { data: categories, error: cErr } = await supabase.from('categories').insert(uniqueCats).select()
  if (cErr) { console.error('Categories insert failed:', cErr.message); process.exit(1) }
  const catMap = {} // "brand_id-category_name" → id
  for (const c of categories) catMap[`${c.brand_id}-${c.category_name}`] = c.id
  console.log(`  Inserted ${categories.length} categories`)

  // ── 4. Insert subcategories ─────────────────────────────────────────────
  console.log('Inserting subcategories...')
  const subPayloads = []
  for (const entry of SEED_CATALOG) {
    const catId = catMap[`${brandMap[entry.brand]}-${entry.category}`]
    for (const sub of entry.subcategories) {
      subPayloads.push({ subcategory_name: sub, category_id: catId })
    }
  }
  const { data: subcategories, error: sErr } = await supabase.from('subcategories').insert(subPayloads).select()
  if (sErr) { console.error('Subcategories insert failed:', sErr.message); process.exit(1) }
  const subMap = {} // subcategory_name → { id, category_id }
  for (const s of subcategories) subMap[s.subcategory_name] = s
  console.log(`  Inserted ${subcategories.length} subcategories`)

  // ── 5. Insert products ──────────────────────────────────────────────────
  console.log('Inserting products...')
  const productPayloads = []
  for (const [subName, productName] of Object.entries(PRODUCT_NAMES)) {
    const sub = subMap[subName]
    if (!sub) continue
    const cat = categories.find(c => c.id === sub.category_id)
    if (!cat) continue
    productPayloads.push({
      product_name: productName,
      product_type: 'hardware',
      brand_id: cat.brand_id,
      category_id: cat.id,
      subcategory_id: sub.id,
      sku: `SKU-${subName.replace(/\s+/g, '-').toUpperCase()}-001`,
      created_date: new Date().toISOString(),
    })
  }
  const { data: products, error: pErr } = await supabase.from('products').insert(productPayloads).select()
  if (pErr) { console.error('Products insert failed:', pErr.message); process.exit(1) }
  console.log(`  Inserted ${products.length} products`)

  // ── 6. Insert customers ─────────────────────────────────────────────────
  console.log('Inserting customers...')
  const now = new Date().toISOString()
  const b2bPayload = B2B_CUSTOMERS.map((c, i) => ({ ...c, customer_type: 'B2B', customer_status: 'Active', customer_code: `B2B-${String(1001 + i).padStart(4, '0')}`, created_date: now, updated_date: now }))
  const b2cPayload = B2C_CUSTOMERS.map((c, i) => ({ ...c, customer_type: 'B2C', customer_status: 'Active', company_name: null, customer_code: `B2C-${String(2001 + i).padStart(4, '0')}`, created_date: now, updated_date: now }))

  const { data: customers, error: custErr } = await supabase.from('customers').insert([...b2bPayload, ...b2cPayload]).select()
  if (custErr) { console.error('Customers insert failed:', custErr.message); process.exit(1) }
  console.log(`  Inserted ${customers.length} customers (${b2bPayload.length} B2B, ${b2cPayload.length} B2C)`)

  // ── 7. Generate 100 tickets ─────────────────────────────────────────────
  console.log('\nGenerating 100 tickets...')

  const tickets = []
  const inventoryQueue = [] // { ticketIndex, products[] }

  for (let i = 0; i < 100; i++) {
    const customer = rand(customers)
    const isB2B = customer.customer_type === 'B2B'
    const customerDisplayName = isB2B ? customer.company_name : customer.contact_person

    const status   = rand(TICKET_STATUSES)
    const priority = rand(PRIORITIES)
    const daysBack = randInt(1, 180)
    const createdAt = daysAgo(daysBack)

    let resolvedDate = null
    if (status === 'Completed' || status === 'Cancelled') {
      resolvedDate = daysAgo(randInt(0, Math.max(0, daysBack - 1)))
    }

    const productCount = pickProductCount()
    const shuffled = [...products].sort(() => Math.random() - 0.5)
    const chosen = shuffled.slice(0, Math.min(productCount, products.length))

    const productList = chosen.map(prod => {
      const statuses = PRODUCT_STATUSES_BY_TICKET[status] || ['Received']
      // Find brand + category names from our inserted data
      const brand = brands.find(b => b.id === prod.brand_id)
      const cat   = categories.find(c => c.id === prod.category_id)
      const sub   = subcategories.find(s => s.id === prod.subcategory_id)
      return {
        product_id:       prod.id,
        product_name:     prod.product_name,
        serial_number:    `SN-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
        quantity:         1,
        issue_description: rand(ISSUES),
        product_status:   rand(statuses),
        warranty_status:  rand(['In Warranty', 'Out of Warranty', 'Unknown']),
        brand:            brand?.brand_name || null,
        category:         cat?.category_name || null,
        subcategory:      sub?.subcategory_name || null,
      }
    })

    tickets.push({
      rma_number:          makeRMANumber(i + 1, daysBack),
      customer_id:         customer.id,
      customer_name:       customerDisplayName,
      ticket_status:       status,
      priority:            priority,
      products:            productList,
      general_description: rand(ISSUES),
      accessories_received: rand([null, null, null, 'Power adapter', 'Carrying bag', 'Original box', 'Keyboard', 'Mouse']),
      due_date:            daysAgo(randInt(-30, daysBack - 1)),
      created_by:          'seed@system.local',
      created_date:        createdAt,
      updated_by:          'seed@system.local',
      updated_date:        resolvedDate || createdAt,
    })

    inventoryQueue.push({ ticketIndex: i, products: productList, status, createdAt })
  }

  // ── 8. Insert tickets ───────────────────────────────────────────────────
  console.log('Inserting tickets...')
  const BATCH = 20
  const insertedTickets = []

  for (let b = 0; b < tickets.length; b += BATCH) {
    const slice = tickets.slice(b, b + BATCH)
    const { data, error } = await supabase.from('rma_tickets').insert(slice).select('id, rma_number')
    if (error) { console.error(`Tickets batch ${b / BATCH + 1} failed:`, error.message); process.exit(1) }
    insertedTickets.push(...data)
    console.log(`  Inserted tickets ${b + 1}–${Math.min(b + BATCH, tickets.length)}`)
  }

  // ── 9. Insert inventory_units ───────────────────────────────────────────
  console.log('\nInserting inventory units...')

  const rmaToId = {}
  for (const t of insertedTickets) rmaToId[t.rma_number] = t.id

  const unitPayloads = []
  for (const entry of inventoryQueue) {
    if (entry.status === 'Cancelled') continue
    const ticket = tickets[entry.ticketIndex]
    const ticketId = rmaToId[ticket.rma_number]
    for (const prod of entry.products) {
      const invStatus = { Received: 'active_rma', 'Under Repair': 'active_rma', Repaired: 'active_rma', "Can't Repair": 'company_stock', Replacement: 'company_stock', 'Credit Note': 'company_stock' }[prod.product_status] || 'active_rma'
      unitPayloads.push({
        rma_ticket_id:   ticketId,
        rma_number:      ticket.rma_number,
        product_name:    prod.product_name,
        serial_number:   prod.serial_number,
        warranty_status: prod.warranty_status || null,
        status:          invStatus,
        resolution_type: invStatus === 'company_stock' ? prod.product_status.toLowerCase().replace(/[^a-z]/g, '_').replace(/_+/g, '_') : null,
        created_date:    entry.createdAt,
      })
    }
  }

  if (unitPayloads.length > 0) {
    for (let b = 0; b < unitPayloads.length; b += BATCH) {
      const slice = unitPayloads.slice(b, b + BATCH)
      const { error } = await supabase.from('inventory_units').insert(slice)
      if (error) {
        if (error.code === '42P01') { console.warn('  inventory_units table missing — run SQL setup from Inventory page first.'); break }
        console.warn(`  Inventory batch warning: ${error.message}`)
      } else {
        process.stdout.write('.')
      }
    }
    console.log()
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n── Seed complete ──────────────────────────────────────────')
  console.log(`  Brands:     ${brands.length}`)
  console.log(`  Products:   ${products.length}`)
  console.log(`  Customers:  ${customers.length} (${b2bPayload.length} B2B, ${b2cPayload.length} B2C)`)
  console.log(`  Tickets:    ${insertedTickets.length}`)

  const multi = tickets.filter(t => t.products.length > 1).length
  const byStatus = {}
  for (const t of tickets) byStatus[t.ticket_status] = (byStatus[t.ticket_status] || 0) + 1
  console.log(`  Multi-product tickets: ${multi}`)
  console.log(`  By status:`, byStatus)
  console.log(`  Inventory units: ${unitPayloads.length}`)
}

main().catch(err => { console.error(err); process.exit(1) })
