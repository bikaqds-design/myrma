import { createClient } from '@supabase/supabase-js'

// Fallbacks prevent createClient from throwing during CI builds and
// mis-configured deployments. The app will load but auth will fail
// until real values are set in the host's environment variables.
export const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co'
export const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseKey)
