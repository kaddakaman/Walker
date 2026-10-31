/* global __WALKER_CONFIG__ */
// Filled in at build time by scripts/build.mjs from environment variables.
export const config =
  typeof __WALKER_CONFIG__ !== 'undefined'
    ? __WALKER_CONFIG__
    : { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', WEB_URL: 'https://kaddakaman.github.io/Walker/' };

/** Accounts, sync and friends only work once Supabase settings are provided. */
export const cloudEnabled = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
