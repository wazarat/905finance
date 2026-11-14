-- An engagement's settlement is either simulated or real GOAT Testnet3.
ALTER TABLE engagements
  ADD CONSTRAINT engagements_settlement_known
  CHECK (settlement IN ('simulated', 'goat_testnet3'));
--> statement-breakpoint

-- Whether an engagement's money is simulated or real is fixed once it is
-- authorized, exactly as its rail is: a simulated engagement can never become
-- a real one, or the reverse, after the buyer has agreed to it.
CREATE OR REPLACE FUNCTION engagements_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'An engagement cannot be moved to another organization or project'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.seller_profile_id IS NOT NULL
     AND NEW.seller_profile_id IS DISTINCT FROM OLD.seller_profile_id THEN
    RAISE EXCEPTION 'The seller of an engagement cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.rail IS NOT NULL
     AND NEW.rail IS DISTINCT FROM OLD.rail
     AND OLD.state NOT IN ('DISCOVERING', 'SELLER_SELECTED') THEN
    RAISE EXCEPTION 'The payment rail of an authorized engagement cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.settlement IS DISTINCT FROM OLD.settlement
     AND OLD.state NOT IN ('DISCOVERING', 'SELLER_SELECTED') THEN
    RAISE EXCEPTION 'The settlement of an authorized engagement cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'An engagement in a terminal state cannot change state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
