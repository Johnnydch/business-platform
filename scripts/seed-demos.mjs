#!/usr/bin/env node
// הקמת עסקי הדגמה סינתטיים (אחד לכל תבנית זמינה): slug = demo-<template>, ללא בעלים, ללא דומיין, ללא טלפון. אידמפוטנטי.
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-demos.mjs
// ההדגמות מבודדות: לא ניתן לשייך להן בעלים או דומיין (נאכף ב-DB), ופניות/תורים בהן נמחקים בתחזוקה השעתית אחרי יום.
import { createRest } from '../lib/clients/supabase-rest.mjs';
const need = (k) => { const v = process.env[k]; if (!v) { console.error('חסר משתנה סביבה: ' + k); process.exit(2); } return v; };
const rest = createRest({ url: need('SUPABASE_URL').replace(/\/$/, ''), anonKey: 'unused', serviceKey: need('SUPABASE_SERVICE_ROLE_KEY') });
const catalog = await rest.service('rpc_public_brand', {});
for (const t of (catalog.data ?? catalog).templates) {
  const r = await rest.service('rpc_admin_seed_demo', { p_template: t.key });
  const d = r.data ?? r;
  console.log(`${t.key}: ${d.created ? 'נוצר' : 'קיים'} → /${t.kind === 'booking' ? 'b' : 'l'}/${d.slug}`);
}
