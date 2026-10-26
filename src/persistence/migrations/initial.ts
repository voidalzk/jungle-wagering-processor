import { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1760000000000 implements MigrationInterface {
  name = 'Initial1760000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY, player_id uuid NOT NULL, currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0), version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(player_id, currency), UNIQUE(id, currency)
      );
      CREATE TABLE transactions (
        id uuid PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES wallets(id), provider_id text NOT NULL,
        external_id text NOT NULL, idempotency_key text NOT NULL UNIQUE, payload_hash text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0), currency varchar(3) NOT NULL,
        input jsonb NOT NULL, status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        result jsonb, reference_id uuid REFERENCES transactions(id), failure_code text,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        UNIQUE(provider_id, external_id), UNIQUE(id, wallet_id, currency),
        CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CHECK (reference_id IS NULL OR reference_id <> id)
      );
      CREATE UNIQUE INDEX one_reversal_per_kind ON transactions(reference_id, kind)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
      CREATE INDEX pending_references ON transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE ledger (
        id uuid PRIMARY KEY, sequence bigserial UNIQUE, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0), currency varchar(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(wallet_id, transaction_id),
        FOREIGN KEY (wallet_id,currency) REFERENCES wallets(id,currency),
        FOREIGN KEY (transaction_id,wallet_id,currency) REFERENCES transactions(id,wallet_id,currency),
        CHECK (balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_cursor ON ledger(wallet_id,sequence);
      CREATE TABLE inbox (
        consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
        transaction_id uuid NOT NULL REFERENCES transactions(id), received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NOT NULL, PRIMARY KEY(consumer_name,message_id)
      );
      CREATE TABLE outbox (
        id uuid PRIMARY KEY, aggregate_id uuid NOT NULL REFERENCES wallets(id), event_type text NOT NULL,
        payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      );
      CREATE INDEX outbox_due ON outbox(next_attempt_at) WHERE published_at IS NULL;

      CREATE FUNCTION forbid_ledger_changes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger is append-only' USING ERRCODE = '23514'; END $$;
      CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_changes();

      CREATE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transactions are audit records' USING ERRCODE = '23514'; END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'terminal transaction' USING ERRCODE = '23514';
        END IF;
        IF (NEW.id,NEW.wallet_id,NEW.provider_id,NEW.external_id,NEW.idempotency_key,NEW.payload_hash,NEW.kind,NEW.amount,NEW.currency,NEW.input)
          IS DISTINCT FROM (OLD.id,OLD.wallet_id,OLD.provider_id,OLD.external_id,OLD.idempotency_key,OLD.payload_hash,OLD.kind,OLD.amount,OLD.currency,OLD.input) THEN
          RAISE EXCEPTION 'immutable transaction payload' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_transactions BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION protect_transaction();

      -- A checagem fica para o commit, depois de saldo e ledger terem sido gravados.
      CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wid uuid; stored numeric; calculated numeric; v integer; expected_version bigint;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
        SELECT balance,version INTO stored,v FROM wallets WHERE id=wid FOR UPDATE;
        SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)
          INTO calculated FROM ledger WHERE wallet_id=wid;
        IF stored IS DISTINCT FROM calculated THEN RAISE EXCEPTION 'wallet and ledger differ' USING ERRCODE='23514'; END IF;
        SELECT 1 + count(*) INTO expected_version FROM ledger l JOIN transactions t ON t.id=l.transaction_id
          WHERE l.wallet_id=wid AND t.kind <> 'OPENING';
        IF v <> expected_version THEN RAISE EXCEPTION 'wallet version differs' USING ERRCODE='23514'; END IF;
        IF EXISTS (
          SELECT 1 FROM (
            SELECT balance_before, lag(balance_after,1,0::numeric) OVER (ORDER BY sequence) AS previous
            FROM ledger WHERE wallet_id=wid
          ) chain WHERE balance_before <> previous
        ) THEN RAISE EXCEPTION 'broken ledger chain' USING ERRCODE='23514'; END IF;
        IF EXISTS (
          SELECT 1 FROM transactions t LEFT JOIN ledger l ON l.transaction_id=t.id AND l.wallet_id=t.wallet_id
          WHERE t.wallet_id=wid AND (
            (t.status='PROCESSED' AND t.kind<>'LOSS' AND l.id IS NULL) OR
            (l.id IS NOT NULL AND (t.status<>'PROCESSED' OR t.kind='LOSS' OR t.amount<>l.amount))
          )
        ) THEN RAISE EXCEPTION 'transaction and ledger differ' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
      CREATE CONSTRAINT TRIGGER ledger_consistency AFTER INSERT ON ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
      CREATE CONSTRAINT TRIGGER transaction_consistency AFTER INSERT OR UPDATE ON transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE outbox, inbox, ledger, transactions, wallets CASCADE;
      DROP FUNCTION check_wallet_ledger(); DROP FUNCTION protect_transaction(); DROP FUNCTION forbid_ledger_changes();`);
  }
}
