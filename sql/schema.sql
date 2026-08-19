CREATE TABLE IF NOT EXISTS lab_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  symbol text NOT NULL CHECK (symbol = 'LABX'),
  quote_asset text NOT NULL CHECK (quote_asset = 'LAB')
);

INSERT INTO lab_config(singleton, schema_version, symbol, quote_asset)
VALUES (true, 1, 'LABX', 'LAB')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  symbol text NOT NULL CHECK (symbol = 'LABX'),
  quote_asset text NOT NULL CHECK (quote_asset = 'LAB'),
  state text NOT NULL CHECK (state IN ('open', 'halted', 'closed')),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 1000000),
  authority_sequence bigint NOT NULL CHECK (authority_sequence BETWEEN 0 AND 10000000),
  cash_supply bigint NOT NULL CHECK (cash_supply BETWEEN 0 AND 320000000000000),
  inventory_supply bigint NOT NULL CHECK (inventory_supply BETWEEN 0 AND 32000000000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO market_state(
  singleton, symbol, quote_asset, state, generation, authority_sequence, cash_supply, inventory_supply
) VALUES (true, 'LABX', 'LAB', 'open', 1, 0, 0, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS operation_receipts (
  operation text NOT NULL,
  request_key text NOT NULL,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  completed boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (operation, request_key),
  CHECK (completed = (result IS NOT NULL)),
  CHECK ((NOT completed AND completed_at IS NULL) OR (completed AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS market_events (
  sequence bigint PRIMARY KEY CHECK (sequence BETWEEN 1 AND 10000000),
  event_kind text NOT NULL CHECK (event_kind IN (
    'account_endowed', 'account_disabled', 'market_state_changed', 'order_accepted',
    'execution_recorded', 'order_canceled', 'publication_created', 'audit_created'
  )),
  entity_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'disabled')),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 1000000),
  initial_cash bigint NOT NULL CHECK (initial_cash BETWEEN 0 AND 10000000000000),
  initial_inventory bigint NOT NULL CHECK (initial_inventory BETWEEN 0 AND 1000000000),
  cash_available bigint NOT NULL CHECK (cash_available BETWEEN 0 AND 320000000000000),
  cash_reserved bigint NOT NULL CHECK (cash_reserved BETWEEN 0 AND 320000000000000),
  inventory_available bigint NOT NULL CHECK (inventory_available BETWEEN 0 AND 32000000000),
  inventory_reserved bigint NOT NULL CHECK (inventory_reserved BETWEEN 0 AND 32000000000),
  create_intent_digest character(64) NOT NULL CHECK (create_intent_digest ~ '^[a-f0-9]{64}$'),
  created_sequence bigint NOT NULL UNIQUE REFERENCES market_events(sequence),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS orders (
  order_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(account_id),
  symbol text NOT NULL CHECK (symbol = 'LABX'),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  limit_price bigint NOT NULL CHECK (limit_price BETWEEN 1 AND 1000000),
  original_quantity bigint NOT NULL CHECK (original_quantity BETWEEN 1 AND 1000000),
  remaining_quantity bigint NOT NULL CHECK (remaining_quantity BETWEEN 0 AND 1000000),
  filled_quantity bigint NOT NULL CHECK (filled_quantity BETWEEN 0 AND 1000000),
  canceled_quantity bigint NOT NULL CHECK (canceled_quantity BETWEEN 0 AND 1000000),
  state text NOT NULL CHECK (state IN ('open', 'partially_filled', 'filled', 'canceled')),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  accepted_sequence bigint NOT NULL UNIQUE REFERENCES market_events(sequence),
  market_generation integer NOT NULL CHECK (market_generation BETWEEN 1 AND 1000000),
  account_generation integer NOT NULL CHECK (account_generation BETWEEN 1 AND 1000000),
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  submit_result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (remaining_quantity + filled_quantity + canceled_quantity = original_quantity),
  CHECK ((state = 'open' AND remaining_quantity > 0 AND filled_quantity = 0 AND canceled_quantity = 0) OR
         (state = 'partially_filled' AND remaining_quantity > 0 AND filled_quantity > 0 AND canceled_quantity = 0) OR
         (state = 'filled' AND remaining_quantity = 0 AND filled_quantity = original_quantity AND canceled_quantity = 0) OR
         (state = 'canceled' AND remaining_quantity = 0 AND canceled_quantity > 0))
);

CREATE INDEX IF NOT EXISTS open_sell_book
ON orders(limit_price ASC, accepted_sequence ASC, order_id ASC)
WHERE side = 'sell' AND state IN ('open', 'partially_filled') AND remaining_quantity > 0;

CREATE INDEX IF NOT EXISTS open_buy_book
ON orders(limit_price DESC, accepted_sequence ASC, order_id ASC)
WHERE side = 'buy' AND state IN ('open', 'partially_filled') AND remaining_quantity > 0;

CREATE TABLE IF NOT EXISTS executions (
  execution_id text PRIMARY KEY,
  sequence bigint NOT NULL UNIQUE REFERENCES market_events(sequence),
  maker_order_id text NOT NULL REFERENCES orders(order_id),
  taker_order_id text NOT NULL REFERENCES orders(order_id),
  buy_order_id text NOT NULL REFERENCES orders(order_id),
  sell_order_id text NOT NULL REFERENCES orders(order_id),
  buyer_account_id text NOT NULL REFERENCES accounts(account_id),
  seller_account_id text NOT NULL REFERENCES accounts(account_id),
  price_ticks bigint NOT NULL CHECK (price_ticks BETWEEN 1 AND 1000000),
  quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (maker_order_id <> taker_order_id),
  CHECK (buy_order_id <> sell_order_id),
  CHECK (buyer_account_id <> seller_account_id)
);

CREATE TABLE IF NOT EXISTS publications (
  publication_id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  market_generation integer NOT NULL CHECK (market_generation BETWEEN 1 AND 1000000),
  as_of_sequence bigint NOT NULL CHECK (as_of_sequence BETWEEN 0 AND 10000000),
  publication_sequence bigint NOT NULL UNIQUE REFERENCES market_events(sequence),
  book jsonb NOT NULL,
  executions jsonb NOT NULL,
  book_item_count integer NOT NULL CHECK (book_item_count BETWEEN 0 AND 2048),
  execution_count integer NOT NULL CHECK (execution_count BETWEEN 0 AND 4096),
  manifest_digest character(64) NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS publication_page_receipts (
  publication_id text NOT NULL REFERENCES publications(publication_id),
  section text NOT NULL CHECK (section IN ('book', 'executions')),
  cursor_key text NOT NULL,
  page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 50),
  result_digest character(64) NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_id, section, cursor_key, page_limit)
);

CREATE TABLE IF NOT EXISTS audits (
  audit_id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  intent_digest character(64) NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  as_of_sequence bigint NOT NULL CHECK (as_of_sequence BETWEEN 0 AND 10000000),
  audit_sequence bigint NOT NULL UNIQUE REFERENCES market_events(sequence),
  passed boolean NOT NULL,
  account_count integer NOT NULL CHECK (account_count BETWEEN 0 AND 32),
  order_count integer NOT NULL CHECK (order_count BETWEEN 0 AND 2048),
  execution_count integer NOT NULL CHECK (execution_count BETWEEN 0 AND 4096),
  event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 10000000),
  mismatch_count integer NOT NULL CHECK (mismatch_count BETWEEN 0 AND 512),
  replay_cash_supply bigint NOT NULL CHECK (replay_cash_supply BETWEEN 0 AND 320000000000000),
  replay_inventory_supply bigint NOT NULL CHECK (replay_inventory_supply BETWEEN 0 AND 32000000000),
  materialized_cash_total bigint NOT NULL,
  materialized_inventory_total bigint NOT NULL,
  audit_digest character(64) NOT NULL CHECK (audit_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable market evidence cannot be changed' USING ERRCODE = '23514';
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lab_config', 'market_events', 'executions', 'publications', 'publication_page_receipts', 'audits'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_immutable', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION protect_order_economics() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.symbol IS DISTINCT FROM OLD.symbol OR
     NEW.side IS DISTINCT FROM OLD.side OR
     NEW.limit_price IS DISTINCT FROM OLD.limit_price OR
     NEW.original_quantity IS DISTINCT FROM OLD.original_quantity OR
     NEW.accepted_sequence IS DISTINCT FROM OLD.accepted_sequence OR
     NEW.market_generation IS DISTINCT FROM OLD.market_generation OR
     NEW.account_generation IS DISTINCT FROM OLD.account_generation OR
     NEW.intent_digest IS DISTINCT FROM OLD.intent_digest OR
     (OLD.submit_result IS NOT NULL AND NEW.submit_result IS DISTINCT FROM OLD.submit_result) THEN
    RAISE EXCEPTION 'immutable order economics cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_economics_immutable ON orders;
CREATE TRIGGER orders_economics_immutable
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION protect_order_economics();

CREATE OR REPLACE FUNCTION protect_account_genesis() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.initial_cash IS DISTINCT FROM OLD.initial_cash OR
     NEW.initial_inventory IS DISTINCT FROM OLD.initial_inventory OR
     NEW.create_intent_digest IS DISTINCT FROM OLD.create_intent_digest OR
     NEW.created_sequence IS DISTINCT FROM OLD.created_sequence THEN
    RAISE EXCEPTION 'immutable account genesis cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_genesis_immutable ON accounts;
CREATE TRIGGER account_genesis_immutable
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION protect_account_genesis();
