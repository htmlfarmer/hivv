-- 015_tip_analytics.sql
-- C4: track which tips are shown and clicked so low-value tips can be pruned.
CREATE TABLE IF NOT EXISTS hivv_tips (
  tip_key     TEXT PRIMARY KEY,        -- regex pattern string
  tip_text    TEXT        NOT NULL,    -- the tip text (for display)
  shown_count  BIGINT      DEFAULT 0,  -- times tip was displayed
  click_count  BIGINT      DEFAULT 0,  -- times user acted on tip (clicked/used)
  last_shown   TIMESTAMPTZ DEFAULT NULL
);

-- Seed with current static tips
INSERT INTO hivv_tips (tip_key, tip_text, shown_count, click_count) VALUES
  ('timed? out|timeout', 'slow or dead endpoint — a smaller model helps: hivv llm suggest · or a specific bee: hivv node-chat <name> "..."', 0, 0),
  ('connection refused|econnrefused', 'peer refused the link — its LLM is localhost-only: hivv firewall --apply --mode lan · cross-network: hivv firewall --apply --mode tailscale', 0, 0),
  ('network error|unreachable|no route|name resolution|name or service not known', 'no route to the hub — check wifi/VPN, then: hivv whoami · the agent reconnects on its own once online', 0, 0),
  ('\b401\b|\b403\b|unauthorized|forbidden', 'auth hiccup — check identity: hivv whoami · if you need admin, set HIVV_CONTROL_TOKEN on the hub', 0, 0),
  ('already in use|port .*busy|address already', 'port conflict — hivv doctor shows who owns it · LLMs default to 8080/11434', 0, 0),
  ('no online nodes|no nodes (found|online)|nobody', 'nobody home — start your own node: hivv start · see the hive: https://hivv.org', 0, 0),
  ('crash.?loop|crash loop', 'agent is crash-looping — hivv logs (last errors) · then hivv doctor --fix', 0, 0),
  ('out of memory|\boom\b|cannot allocate', 'RAM is the bottleneck — hivv llm suggest · pick a smaller model · hivv free to see what''s eating memory', 0, 0),
  ('not running|agent (is )?not up|stopped', 'the agent isn''t running — hivv start · auto-fix: hivv doctor --fix', 0, 0),
  ('model .{0,20}not found|no model|pull first', 'no local model — hivv llm suggest · hivv llm pull <model> · or hivv llm pull-gguf gemma4:e2b', 0, 0),
  ('certificate|ssl|tls', 'TLS trouble — check the clock (certs are time-sensitive) · corporate proxies may intercept https', 0, 0),
  ('permission denied', 'permission denied — file owned by another user? sudo chown -R "$USER" ~/.config/hivv ~/.local/share/hivv · or reinstall user-local with --prefix=$HOME/.local', 0, 0),
  ('python.{0,20}not found', 'python3 missing — Linux: apt install python3 · macOS: brew install python3 · Windows: winget install Python.Python.3.12', 0, 0)
ON CONFLICT (tip_key) DO NOTHING;
