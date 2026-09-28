-- Run with: supabase test db
-- Everything happens inside a transaction that is rolled back at the end.
begin;
create extension if not exists pgtap;

select plan(14);

-- Fixtures ------------------------------------------------------------------

insert into payments (id, provider_payment_id, amount_cents) values
  ('00000000-0000-0000-0000-000000000001', 'py_tap_returned', 1000),
  ('00000000-0000-0000-0000-000000000002', 'py_tap_refunded', 1000),
  ('00000000-0000-0000-0000-000000000003', 'py_tap_authorized', 1000);

update payments set status = 'settled' where id in (
  '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
update payments set status = 'returned', return_code = 'R01' where id = '00000000-0000-0000-0000-000000000001';
update payments set status = 'refunded' where id = '00000000-0000-0000-0000-000000000002';

-- Legal path ------------------------------------------------------------------

select is(
  (select status::text from payments where id = '00000000-0000-0000-0000-000000000001'),
  'returned',
  'authorized -> settled -> returned is allowed');

select is(
  (select array_agg(coalesce(from_status::text, '-') || '>' || to_status::text order by id)
     from payment_status_history where payment_id = '00000000-0000-0000-0000-000000000001'),
  array['->authorized', 'authorized>settled', 'settled>returned'],
  'history records each transition');

-- Illegal transitions -----------------------------------------------------------

select throws_ok(
  $$ update payments set status = 'settled', return_code = null
     where id = '00000000-0000-0000-0000-000000000001' $$,
  'PX409', null,
  'returned -> settled is refused');

select throws_ok(
  $$ update payments set status = 'refunded', return_code = null
     where id = '00000000-0000-0000-0000-000000000001' $$,
  'PX409', null,
  'returned -> refunded is refused');

select throws_ok(
  $$ update payments set status = 'settled' where id = '00000000-0000-0000-0000-000000000002' $$,
  'PX409', null,
  'refunded -> settled is refused');

select throws_ok(
  $$ update payments set status = 'returned', return_code = 'R01'
     where id = '00000000-0000-0000-0000-000000000003' $$,
  'PX409', null,
  'authorized -> returned is refused (must settle first)');

select throws_ok(
  $$ update payments set status = 'refunded' where id = '00000000-0000-0000-0000-000000000003' $$,
  'PX409', null,
  'authorized -> refunded is refused');

select throws_ok(
  $$ insert into payments (provider_payment_id, amount_cents, status) values ('py_tap_x', 1, 'settled') $$,
  'PX409', null,
  'a payment cannot be born settled');

select throws_ok(
  $$ delete from payments where id = '00000000-0000-0000-0000-000000000003' $$,
  'PX409', null,
  'payments cannot be deleted');

select is(
  (select status::text from payments where id = '00000000-0000-0000-0000-000000000001'),
  'returned',
  'refused updates left the row untouched');

-- R-code constraints ------------------------------------------------------------

update payments set status = 'settled' where id = '00000000-0000-0000-0000-000000000003';

select throws_ok(
  $$ update payments set status = 'returned' where id = '00000000-0000-0000-0000-000000000003' $$,
  '23514', null,
  'returned requires an R-code');

select throws_ok(
  $$ update payments set status = 'returned', return_code = 'NSF'
     where id = '00000000-0000-0000-0000-000000000003' $$,
  '23514', null,
  'R-code must look like R01');

-- Webhook idempotency -------------------------------------------------------------

insert into webhook_events (event_id, type, payload) values ('evt_tap_1', 'payment.settled', '{}');

select throws_ok(
  $$ insert into webhook_events (event_id, type, payload) values ('evt_tap_1', 'payment.settled', '{}') $$,
  '23505', null,
  'event_id is unique');

select is(
  (select count(*)::int from webhook_events where event_id = 'evt_tap_1'),
  1,
  'exactly one row per event_id');

select * from finish();
rollback;
