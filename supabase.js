/* QR Dine - Supabase connection

*/
const SUPABASE_URL = "https://cchuptqjnrexymavvikv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ntfFJBkY34euu81e9iRuLg_18ftOAgL";

if (!window.supabase) {
  throw new Error("Supabase library did not load. Check the CDN script in index.html.");
}
if (SUPABASE_URL.startsWith("YOUR_") || SUPABASE_PUBLISHABLE_KEY.startsWith("YOUR_")) {
  console.warn("QR Dine: add your Supabase URL and publishable key in supabase.js");
}

window.qrDineSupabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);
