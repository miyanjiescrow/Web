import { createClient } from '@supabase/supabase-js';

// Prioritize SUPABASE_ URL/KEY as requested by user
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY || import.meta.env.SUPABASE_KEY || '';

const isValidUrl = (url: string) => {
  try {
    return url.startsWith('http') && new URL(url);
  } catch {
    return false;
  }
};

export const isConfigured = !!(supabaseUrl && isValidUrl(supabaseUrl) && !supabaseUrl.includes('placeholder'));

// Create a client even if not configured (to avoid undefined errors), 
// but we'll use isConfigured to decide whether to use it.
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder'
);

export const IS_DEMO_MODE = !isConfigured || localStorage.getItem('mianji_demo_mode') === 'true';
