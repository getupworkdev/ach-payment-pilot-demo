-- ACH payment pilot: payments state machine, webhook idempotency, POS order tracking.
--
-- Payment lifecycle (enforced by trg_payments_enforce_transition):
--
--   authorized ──► settled ──► returned   (ACH return, carries an R-code)
--                          └─► refunded   (merchant-initiated refund completed)
--
-- Anything else is refused by the database, whatever code path attempts it.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type payment_status as enum ('authorized', 'settled', 'returned', 'refunded');

create type pos_status as enum ('submitted', 'confirmed', 'unconfirmed');

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  provider_payment_id text not null unique,
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null default 'USD',
  status              payment_status not null default 'authorized',
  return_code         text check (return_code ~ '^R[0-9]{2}$'),
  authorized_at       timestamptz not null default now(),
  settled_at          timestamptz,
  returned_at         timestamptz,
  refunded_at         timestamptz,
  updated_at          timestamptz not null default now(),
  -- An R-code is present exactly when the payment has been returned.
  constraint return_code_iff_returned check ((status = 'returned') = (return_code is not null))
);

-- Allowed edges of the state machine. Kept as data so the trigger, tests and
-- docs all read from one place.
create table payment_status_transitions (
  from_status payment_status not null,
  to_status   payment_status not null,
  primary key (from_status, to_status)
);

insert into payment_status_transitions (from_status, to_status) values
  ('authorized', 'settled'),
  ('settled',    'returned'),
  ('settled',    'refunded');

-- Append-only audit trail of every status change.
create table payment_status_history (
  id          bigint generated always as identity primary key,
  payment_id  uuid not null references payments (id),
  from_status payment_status,
  to_status   payment_status not null,
  return_code text,
  changed_at  timestamptz not null default now()
);

create index payment_status_history_payment_idx on payment_status_history (payment_id);

create function payments_enforce_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'authorized' then
      raise exception 'illegal payment transition: new payments must start as authorized, got %', new.status
        using errcode = 'PX409';
    end if;
    return new;
  end if;

  new.updated_at := now();

  -- Non-status updates (timestamps etc.) pass straight through.
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not exists (
    select 1 from payment_status_transitions
    where from_status = old.status and to_status = new.status
  ) then
    raise exception 'illegal payment transition: % -> % (payment %)', old.status, new.status, old.id
      using errcode = 'PX409';
  end if;

  return new;
end;
$$;

-- BEFORE, so a refused change never lands.
create trigger trg_payments_enforce_transition
  before insert or update on payments
  for each row execute function payments_enforce_transition();

create function payments_record_history() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into payment_status_history (payment_id, from_status, to_status, return_code)
      values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, new.return_code);
  end if;
  return null;
end;
$$;

create trigger trg_payments_record_history
  after insert or update on payments
  for each row execute function payments_record_history();

create function payments_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'payments are never deleted (payment %)', old.id using errcode = 'PX409';
end;
$$;

create trigger trg_payments_forbid_delete
  before delete on payments
  for each row execute function payments_forbid_delete();

-- ---------------------------------------------------------------------------
-- webhook_events: one row per provider event we have processed.
-- The primary key on event_id is the idempotency guarantee.
-- ---------------------------------------------------------------------------

create table webhook_events (
  event_id            text primary key,
  type                text not null,
  provider_payment_id text,
  payload             jsonb not null,
  outcome             text not null default 'processed' check (outcome in ('processed', 'ignored')),
  received_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- orders: what was sent to the POS, keyed by the client's idempotency key.
-- ---------------------------------------------------------------------------

create table orders (
  id                  uuid primary key default gen_random_uuid(),
  idempotency_key     text not null unique,
  payment_id          uuid unique references payments (id),
  amount_cents        integer not null check (amount_cents > 0),
  items               jsonb not null default '[]'::jsonb,
  pos_status          pos_status not null default 'submitted',
  pos_order_id        text,
  last_pos_error      text,
  reconcile_attempts  integer not null default 0,
  needs_staff_review  boolean not null default false,
  staff_review_reason text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint confirmed_has_pos_order_id check ((pos_status = 'confirmed') = (pos_order_id is not null))
);

create index orders_needing_reconcile_idx on orders (pos_status) where pos_status <> 'confirmed';
create index orders_staff_review_idx on orders (needs_staff_review) where needs_staff_review;

create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_orders_touch before update on orders
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- reconciliation_flags: things a human should look at.
-- At most one open flag per (kind, subject) so repeated runs don't pile up noise.
-- ---------------------------------------------------------------------------

create table reconciliation_flags (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('payment_state_mismatch', 'payment_missing_in_db', 'payment_missing_at_provider')),
  subject_id  text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index reconciliation_flags_one_open_idx
  on reconciliation_flags (kind, subject_id) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Access: nothing here is exposed through the Data API. Edge Functions connect
-- with the database URL; anon/authenticated get no policies and so no rows.
-- ---------------------------------------------------------------------------

alter table payments                   enable row level security;
alter table payment_status_transitions enable row level security;
alter table payment_status_history     enable row level security;
alter table webhook_events             enable row level security;
alter table orders                     enable row level security;
alter table reconciliation_flags       enable row level security;
