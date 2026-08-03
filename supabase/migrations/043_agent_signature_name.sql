-- ============================================================
-- 043_agent_signature_name
--
-- Let an agent sign under a name that isn't their own.
--
-- 042 derived the signature from `profiles.full_name`. That breaks
-- a common support-desk pattern: the customer-facing persona is
-- deliberately NOT the employee's real name ("Ana, do atendimento"),
-- and it has to survive staff turnover — the person changes, the
-- persona doesn't. Deriving from the real name also leaks the
-- employee's identity to every customer, which some teams treat as
-- a safety matter.
--
-- So: an optional override. NULL / empty keeps 042's behavior
-- (first word of `full_name`), which is why this needs no backfill
-- and can't change what any existing profile already sends.
--
-- The 40-char cap is a display concern — the signature is the first
-- line the customer reads, and a long one buries the message. It
-- comfortably fits "Ana | Atendimento".
--
-- RLS: unchanged. "Users can update own profile" (001) already
-- scopes writes to auth.uid().
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS signature_name TEXT;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_signature_name_length;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_signature_name_length
  CHECK (signature_name IS NULL OR char_length(signature_name) <= 40);

COMMENT ON COLUMN profiles.signature_name IS
  'Optional display name used in the outbound message signature. NULL/empty falls back to the first word of full_name. Lets a team keep a customer-facing persona that outlives the employee behind it.';
