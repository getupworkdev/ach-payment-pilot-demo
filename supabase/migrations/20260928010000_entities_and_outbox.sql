-- Multi-entity support and a transactional outbox for calls to the provider.
--
-- entity_id: the legal/merchant entity a payment belongs to. Each entity has
-- its own provider credentials, and every provider call must be made with
-- that entity's token (see _shared/entity_tokens.ts).
--
-- outbox: anything we need to tell the provider is written here in the same
-- database transaction as the business change that caused it. A worker sends
-- it later, with an idempotency key, retrying temporary failures. Nothing is
-- lost if the process dies or the provider is down: the row is still there.

alter table payments add column entity_id text not null default 'store-001';
create index payments_entity_idx on payments (entity_id);

-- ---------------------------------------------------------------------------
-- refunds: the business change. A refund request is ours until the provider
-- accepts it (submitted); the payment itself only moves to 'refunded' when the
-- provider's refund.completed webhook arrives.
-- ---------------------------------------------------------------------------

create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments (id),
  entity_id          text not null,
  amount_cents       integer not null check (amount_cents > 0),
  reason             text not null,
  status             text not null default 'requested'
                       check (status in ('requested', 'submitted', 'needs_review')),
  provider_refund_id text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index refunds_payment_idx on refunds (payment_id);

create trigger trg_refunds_touch before update on refunds
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- outbox
-- ---------------------------------------------------------------------------

create table outbox (
  id              uuid primary key default gen_random_uuid(),
  entity_id       text not null,
  topic           text not null,
  payload         jsonb not null,
  -- Sent with every attempt, so a retry after a lost response can't create a
  -- second refund at the provider.
  idempotency_key text not null unique,
  status          text not null default 'pending'
                    check (status in ('pending', 'sending', 'sent', 'review')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  response        jsonb,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint sent_has_timestamp check ((status = 'sent') = (sent_at is not null))
);

-- The worker's claim query: due rows, oldest first.
create index outbox_due_idx on outbox (next_attempt_at) where status in ('pending', 'sending');

create trigger trg_outbox_touch before update on outbox
  for each row execute function touch_updated_at();

-- The review list: messages a person has to look at. Validation failures land
-- here straight away; temporary failures only after max attempts.
-- security_invoker: otherwise the view runs as its owner and would bypass the
-- RLS on outbox for anyone Supabase's default grants let select from it.
create view outbox_review with (security_invoker = true) as
  select id, entity_id, topic, idempotency_key, attempts, last_error, payload, updated_at
  from outbox
  where status = 'review';

alter table refunds enable row level security;
alter table outbox  enable row level security;
