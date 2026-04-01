-- Support Ticketing System
-- Adds support ticket creation, messaging, and admin management

-- ============================================================
-- Sequence: ticket_number (human-readable IDs like #1001)
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq START WITH 1001;

-- ============================================================
-- Table: support_tickets
-- ============================================================
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  ticket_number integer NOT NULL DEFAULT nextval('support_ticket_number_seq'),
  subject text NOT NULL CHECK (char_length(subject) <= 200),
  category text NOT NULL CHECK (category IN ('billing', 'event_help', 'technical', 'account', 'other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_number_unique ON support_tickets (ticket_number);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status);
CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_event_idx ON support_tickets (event_id) WHERE event_id IS NOT NULL;

-- ============================================================
-- Table: support_messages
-- ============================================================
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'admin')),
  message text NOT NULL CHECK (char_length(message) <= 5000),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, created_at ASC);

-- ============================================================
-- Trigger: update updated_at on ticket changes
-- ============================================================
CREATE OR REPLACE FUNCTION update_support_ticket_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_tickets_updated_at ON support_tickets;
CREATE TRIGGER support_tickets_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION update_support_ticket_timestamp();

-- Also update ticket timestamp when a new message is added
CREATE OR REPLACE FUNCTION update_ticket_on_message()
RETURNS trigger AS $$
BEGIN
  UPDATE support_tickets SET updated_at = now() WHERE id = NEW.ticket_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_messages_update_ticket ON support_messages;
CREATE TRIGGER support_messages_update_ticket
  AFTER INSERT ON support_messages
  FOR EACH ROW EXECUTE FUNCTION update_ticket_on_message();

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- Users can view their own tickets
DROP POLICY IF EXISTS support_tickets_select_own ON support_tickets;
CREATE POLICY support_tickets_select_own ON support_tickets
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own tickets
DROP POLICY IF EXISTS support_tickets_insert_own ON support_tickets;
CREATE POLICY support_tickets_insert_own ON support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can view messages on their own tickets
DROP POLICY IF EXISTS support_messages_select_own ON support_messages;
CREATE POLICY support_messages_select_own ON support_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM support_tickets WHERE id = ticket_id AND user_id = auth.uid())
  );

-- Users can insert messages on their own tickets
DROP POLICY IF EXISTS support_messages_insert_own ON support_messages;
CREATE POLICY support_messages_insert_own ON support_messages
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM support_tickets WHERE id = ticket_id AND user_id = auth.uid())
  );

-- Service role (API) bypasses RLS for admin operations
