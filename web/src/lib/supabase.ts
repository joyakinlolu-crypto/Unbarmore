import 'server-only';
import { createClient } from '@supabase/supabase-js';

// Service-role client: bypasses RLS, so EVERY query in this app must be scoped by the business_id
// from the verified session. Never take a business_id from a request body or URL.
export const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
