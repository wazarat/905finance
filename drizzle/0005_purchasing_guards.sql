-- Purchasing invariants enforced by the database itself.

-- A reservation may never take an engagement past its authorized budget, and
-- a single purchase may never exceed the per-purchase limit. The mandate row
-- is locked first, so simultaneous reservations are checked one at a time and
-- cannot both squeeze under the limit.
CREATE OR REPLACE FUNCTION spending_reservations_guard() RETURNS trigger AS $$
DECLARE
  mandate spending_mandates%ROWTYPE;
  reserved numeric;
BEGIN
  SELECT * INTO mandate FROM spending_mandates WHERE id = NEW.mandate_id FOR UPDATE;
  IF NOT FOUND OR mandate.engagement_id IS DISTINCT FROM NEW.engagement_id THEN
    RAISE EXCEPTION 'A reservation must belong to its engagement''s mandate'
      USING ERRCODE = '23514';
  END IF;
  IF mandate.status <> 'authorized' THEN
    RAISE EXCEPTION 'Spending can only be reserved against an authorized mandate'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.amount_units > mandate.per_transaction_limit_units THEN
    RAISE EXCEPTION 'A reservation cannot exceed the per-purchase limit'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount_units), 0) INTO reserved
    FROM spending_reservations
    WHERE mandate_id = NEW.mandate_id AND status IN ('held', 'committed');
  IF reserved + NEW.amount_units > mandate.total_authorized_units THEN
    RAISE EXCEPTION 'A reservation cannot exceed the authorized budget'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER spending_reservations_guard
  BEFORE INSERT ON spending_reservations
  FOR EACH ROW EXECUTE FUNCTION spending_reservations_guard();
--> statement-breakpoint

-- A reservation keeps its amount and its mandate, and once settled it stays settled.
CREATE OR REPLACE FUNCTION spending_reservations_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_units IS DISTINCT FROM OLD.amount_units
     OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id
     OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.purchase_id IS DISTINCT FROM OLD.purchase_id THEN
    RAISE EXCEPTION 'A reservation cannot be altered' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'held' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A settled reservation cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER spending_reservations_immutable
  BEFORE UPDATE ON spending_reservations
  FOR EACH ROW EXECUTE FUNCTION spending_reservations_immutable();
--> statement-breakpoint

-- No message between an agent and a seller can be recorded unless the
-- engagement is ACTIVE and the seller is the one selected for it.
CREATE OR REPLACE FUNCTION agent_messages_guard() RETURNS trigger AS $$
DECLARE
  engagement_state engagement_state;
  engagement_seller uuid;
BEGIN
  IF NEW.direction = 'platform' THEN
    RETURN NEW;
  END IF;
  SELECT state, seller_profile_id INTO engagement_state, engagement_seller
    FROM engagements WHERE id = NEW.engagement_id;
  IF engagement_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Agent and seller may only communicate while the engagement is ACTIVE'
      USING ERRCODE = '23514';
  END IF;
  IF engagement_seller IS DISTINCT FROM NEW.seller_profile_id THEN
    RAISE EXCEPTION 'An agent may only communicate with its engagement''s selected seller'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_messages_guard
  BEFORE INSERT ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION agent_messages_guard();
--> statement-breakpoint

-- A confirmed payment is permanent and must match the attempt it confirms.
CREATE OR REPLACE FUNCTION payment_transactions_guard() RETURNS trigger AS $$
DECLARE
  attempt payment_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A confirmed payment cannot be altered' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;
  IF NOT FOUND
     OR attempt.engagement_id IS DISTINCT FROM NEW.engagement_id
     OR attempt.engagement_wallet_id IS DISTINCT FROM NEW.engagement_wallet_id
     OR attempt.purchase_id IS DISTINCT FROM NEW.purchase_id
     OR attempt.amount_units IS DISTINCT FROM NEW.amount_units
     OR attempt.recipient IS DISTINCT FROM NEW.recipient
     OR attempt.rail IS DISTINCT FROM NEW.rail THEN
    RAISE EXCEPTION 'A confirmed payment must match its payment attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_transactions_guard
  BEFORE INSERT OR UPDATE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION payment_transactions_guard();
