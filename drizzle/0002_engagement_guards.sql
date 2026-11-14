-- Invariants enforced by the database itself, so they hold even if
-- application code is wrong or bypassed.

-- An engagement keeps its organization, project and seller for life; its rail
-- is fixed once it has been authorized; terminal states are final.
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
  IF OLD.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'An engagement in a terminal state cannot change state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER engagements_guard
  BEFORE UPDATE ON engagements
  FOR EACH ROW EXECUTE FUNCTION engagements_guard();
--> statement-breakpoint

-- A wallet belongs to exactly one engagement, on one rail, permanently.
CREATE OR REPLACE FUNCTION engagement_wallets_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.rail IS DISTINCT FROM OLD.rail
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'An engagement wallet cannot be reassigned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER engagement_wallets_guard
  BEFORE UPDATE ON engagement_wallets
  FOR EACH ROW EXECUTE FUNCTION engagement_wallets_guard();
--> statement-breakpoint

-- A mandate stays with its engagement and its approved seller.
CREATE OR REPLACE FUNCTION spending_mandates_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.seller_profile_id IS DISTINCT FROM OLD.seller_profile_id THEN
    RAISE EXCEPTION 'A spending mandate cannot be moved to another engagement or seller'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER spending_mandates_guard
  BEFORE UPDATE ON spending_mandates
  FOR EACH ROW EXECUTE FUNCTION spending_mandates_guard();
--> statement-breakpoint

-- A master account stays with its organization and rail.
CREATE OR REPLACE FUNCTION master_wallet_accounts_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.rail IS DISTINCT FROM OLD.rail THEN
    RAISE EXCEPTION 'A master account cannot be moved to another organization or rail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER master_wallet_accounts_guard
  BEFORE UPDATE ON master_wallet_accounts
  FOR EACH ROW EXECUTE FUNCTION master_wallet_accounts_guard();
