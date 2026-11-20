// Public settings for the Vibe by Side page. Copy this file to public/config.js and fill it in.
// The publishable key is meant to be public; Row Level Security in supabase/schema.sql is what protects the data.
window.OMNIVIBE = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-SUPABASE-PUBLISHABLE-KEY',
  filesUrl: 'https://YOUR-FILES-WORKER.workers.dev', // worker/files-worker.js
};
