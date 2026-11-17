-- Add tokens_per_sec to usage_logs for performance tracking
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS tokens_per_sec DECIMAL(10,2);

-- Add index for performance queries
CREATE INDEX IF NOT EXISTS idx_usage_logs_tokens_per_sec ON usage_logs(tokens_per_sec) WHERE tokens_per_sec IS NOT NULL;
