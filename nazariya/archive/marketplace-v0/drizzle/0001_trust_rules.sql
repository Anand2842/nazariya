-- Custom trust rules that must hold even if application code is wrong.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS properties_addr_trgm ON properties USING gin (normalized_address gin_trgm_ops);
--> statement-breakpoint
-- Audit log is append-only.
CREATE OR REPLACE FUNCTION nz_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION nz_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION nz_forbid_mutation();
--> statement-breakpoint
-- Charges are immutable once written (a price change creates a new plan version).
CREATE TRIGGER charges_no_update BEFORE UPDATE ON charges FOR EACH ROW EXECUTE FUNCTION nz_forbid_mutation();
--> statement-breakpoint
-- Price plans: the only permitted update is superseding the current version, exactly once.
CREATE OR REPLACE FUNCTION nz_price_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'price plan % is already superseded and immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.superseded_at IS NULL
     OR NEW.base_paise IS DISTINCT FROM OLD.base_paise
     OR NEW.plan_key IS DISTINCT FROM OLD.plan_key
     OR NEW.applies_to IS DISTINCT FROM OLD.applies_to
     OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id THEN
    RAISE EXCEPTION 'price plans are insert-only; only superseded_at may be set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER price_plans_guard BEFORE UPDATE ON price_plans FOR EACH ROW EXECUTE FUNCTION nz_price_plan_guard();
--> statement-breakpoint
-- At most one current version per (listing, plan_key).
CREATE UNIQUE INDEX IF NOT EXISTS price_plans_one_current ON price_plans (listing_id, plan_key) WHERE superseded_at IS NULL;
--> statement-breakpoint
-- Hotel inventory can never go negative.
ALTER TABLE nightly_inventory ADD CONSTRAINT nightly_inventory_nonneg CHECK (available_count >= 0);
--> statement-breakpoint
-- Listings may only be published with an active authorisation.
CREATE OR REPLACE FUNCTION nz_listing_publish_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF NEW.status = 'published' AND (OLD.status IS DISTINCT FROM 'published') THEN
    SELECT status INTO st FROM property_authorizations WHERE id = NEW.authorization_id;
    IF st IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'listing % cannot be published without an active authorisation', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER listings_publish_guard BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION nz_listing_publish_guard();
