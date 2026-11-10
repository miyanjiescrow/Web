import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY || import.meta.env.SUPABASE_KEY || '';

console.log("Supabase initialization check:", { 
  hasUrl: !!supabaseUrl, 
  hasKey: !!supabaseKey,
  urlStart: supabaseUrl ? supabaseUrl.substring(0, 10) + '...' : 'none'
});

export const isConfigured = !!(supabaseUrl && supabaseKey);
export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');
