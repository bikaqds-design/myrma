import { supabase } from './client.js'

export const ai = {
  async assist(contextType, data) {
    const { data: result, error } = await supabase.functions.invoke('ai-assist', {
      body: { context_type: contextType, data },
    })
    if (error) throw error
    if (result?.error) throw new Error(result.error)
    return result
  },
}
