-- Preserve the source's Global API Key + email scheme separately from tokens.
-- api_token stays NOT NULL for older record documents; it is empty for keys.
-- mailrun_installation already belongs to the System backup group. Its new
-- nullable columns are included automatically; older records default to NULL.
ALTER TABLE mailrun_installation ADD COLUMN api_key TEXT;
ALTER TABLE mailrun_installation ADD COLUMN api_email TEXT;
