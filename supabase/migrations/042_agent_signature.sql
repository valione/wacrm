-- ============================================================
-- 042_agent_signature
--
-- Per-agent message signature.
--
-- On WhatsApp every outbound message carries the business phone
-- number as its identity — there is no per-sender field in either
-- the Cloud API or the QR providers. With more than one agent
-- working an inbox, the customer cannot tell whether they are
-- talking to the same person as yesterday.
--
-- The industry answer is to prefix the agent's name into the
-- message body. We store the opt-in per profile (each agent
-- decides for themselves) rather than per account, and default it
-- OFF so existing installations keep sending byte-identical
-- messages until someone deliberately turns it on.
--
-- The name itself is NOT stored here — it is derived from the
-- existing `profiles.full_name` at send time, so renaming yourself
-- in Settings changes the signature with no extra write.
--
-- RLS: no change needed. The existing "Users can update own
-- profile" policy from 001 already scopes writes to auth.uid(),
-- which is exactly who should flip their own signature.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS signature_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.signature_enabled IS
  'When true, messages this agent sends from the dashboard are prefixed with their first name. Flows, automations, broadcasts and the public API never sign.';
