-- 012_usage_feature.sql
-- C3: add feature column to usage_logs so hive-mind (and future features)
-- can be tracked distinctly from plain chat.
ALTER TABLE usage_logs ADD COLUMN feature VARCHAR(64) DEFAULT NULL;
CREATE INDEX idx_usage_logs_feature ON usage_logs(feature) WHERE feature IS NOT NULL;
