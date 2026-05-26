// Barrel re-export — all domain logic has moved to separate files.
// All existing consumers can continue to use any of these named imports unchanged:
//   import { db, auth, supabase, storage, branding, notifications, backup } from '.../supabaseClient'
//
// Domain file locations:
//   supabase / URL / key   → src/api/client.js
//   auth                   → src/api/auth.js
//   db.*                   → src/api/db/index.js  (assembles from db/*.js)
//   storage                → src/api/storage.js
//   branding               → src/api/branding.js
//   notifications (email)  → src/api/email.js
//   backup                 → src/api/backup.js

export { supabase, supabaseUrl, supabaseKey } from './client.js'
export { auth } from './auth.js'
export { db } from './db/index.js'
export { storage } from './storage.js'
export { branding } from './branding.js'
export { notifications } from './email.js'
export { backup } from './backup.js'
