import test from 'node:test';
import assert from 'node:assert/strict';
import { rpc, psql } from './support/pg.mjs';

test('smoke: קטלוג תבניות נטען ופונקציות הוולידציה עובדות', async () => {
  const t = await psql("select count(*) from templates where status = 'available'");
  assert.equal(t, '5');
  assert.equal(await psql("select app.normalize_phone('054-123 4567')"), '0541234567');
  assert.equal(await psql("select app.normalize_phone('+972541234567')"), '0541234567');
  assert.equal(await psql("select coalesce(app.normalize_phone('0541111111'),'null')"), 'null');
  assert.equal(await psql("select coalesce(app.normalize_phone('0212345678'),'null')"), 'null');
  assert.equal(await psql("select app.clean_name('דניאל')"), 'דניאל');
  assert.equal(await psql("select coalesce(app.clean_name('<b>x</b>'),'null')"), 'null');
  assert.equal(await psql("select coalesce(app.clean_name('א'),'null')"), 'null');
  assert.equal(await psql("select length(app.new_token())"), '43');
  const r = await rpc('rpc_public_businesses');
  assert.equal(r.data.ok, true);
});
