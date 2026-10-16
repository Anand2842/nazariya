-- Audit log is append-only, enforced by the database.
CREATE OR REPLACE FUNCTION nz_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION nz_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION nz_forbid_mutation();
--> statement-breakpoint
-- A published space must have at least one room (defence in depth for the publish checklist).
CREATE OR REPLACE FUNCTION nz_space_publish_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published'
     AND NOT EXISTS (SELECT 1 FROM zones WHERE space_id = NEW.id) THEN
    RAISE EXCEPTION 'space % cannot be published without rooms', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER spaces_publish_guard BEFORE UPDATE ON spaces FOR EACH ROW EXECUTE FUNCTION nz_space_publish_guard();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS view_events_name_idx ON view_events (space_id, name, occurred_at);
