import { createClient } from '@supabase/supabase-js';

// Prioritize SUPABASE_ URL/KEY as requested by user
// Using import.meta.env which Vite populates from process.env
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY || import.meta.env.SUPABASE_KEY || '';

export const isConfigured = !!(supabaseUrl && !supabaseUrl.includes('placeholder'));

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder'
);
