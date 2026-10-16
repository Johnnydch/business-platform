import { loadConfig } from './config.mjs';
import { createRest } from './clients/supabase-rest.mjs';
import { createAuth } from './clients/supabase-auth.mjs';
import { createApi } from './api.mjs';

export function createApiFromEnv(env = process.env) {
  const config = loadConfig(env);
  const keys = { url: config.supabaseUrl, anonKey: config.anonKey, serviceKey: config.serviceKey };
  return createApi({ rest: createRest(keys), auth: createAuth(keys), config });
}
