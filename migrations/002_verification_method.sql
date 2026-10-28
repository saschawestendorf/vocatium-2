-- Art der Verifizierung je Kanal: per Code oder mündlich erteilte Genehmigung (Code nicht angekommen).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS email_verification_method TEXT CHECK (email_verification_method IN ('code', 'verbal')),
  ADD COLUMN IF NOT EXISTS phone_verification_method TEXT CHECK (phone_verification_method IN ('code', 'verbal'));
UPDATE leads SET email_verification_method = 'code' WHERE email_verified_at IS NOT NULL AND email_verification_method IS NULL;
UPDATE leads SET phone_verification_method = 'code' WHERE phone_verified_at IS NOT NULL AND phone_verification_method IS NULL;
