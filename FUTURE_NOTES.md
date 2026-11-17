# HIVV.org — Future Architecture Notes

## Password-Protected AI System (IMPLEMENTED)

### Overview
Users can register accounts and store private API keys for Claude, ChatGPT, Gemini, Minimax, Mimo, etc.
When logged in, their private keys are used first. Open AIs (local, donor pool, built-in) remain available to everyone.

### Database Schema

```sql
-- Users table
users (id, username UNIQUE, password_hash, display_name, role, email, is_active, created_at, last_login_at, visitor_id)

-- Per-user private API keys
user_keys (id, user_id FK->users, provider, model, api_endpoint, key_value, is_active, notes, created_at, last_used_at, total_uses)
```

### Auth Flow
1. POST /api/auth/register {username, password, display_name, link_visitor_id?} -> session cookie + token
2. POST /api/auth/login {username, password, link_visitor_id?} -> session cookie + token
3. Session stored in-memory (Map), 7-day TTL, signed cookie
4. Pass session via: signed cookie `hivv_session`, or `X-Session-Token` header, or `?session_token=` query

### Chat Routing (when authenticated)
1. **User's private keys** (filtered by provider/model if specified)
2. Local AI (auto-discovered via registered nodes)
3. Donor pool (claim_api_key from database)
4. Built-in keys (mimo, minimax hardcoded)

### Chat Routing (when NOT authenticated)
1. Local AI
2. Donor pool
3. Built-in keys

### AI Selector (Frontend)
- Dropdown on homepage: Auto (try all) | Local only | OpenAI | Anthropic | Google | Minimax | Mimo | etc.
- "Auto" = try all user keys in order, then public flow
- Specific provider = filter user keys to that provider, then public flow
- Session token passed via X-Session-Token header on fetch()

### Pages
- `/account.html` — Login, register, key management
- `/terms.html` — Terms of Service
- `/privacy.html` — Privacy Policy
- `/aup.html` — Acceptable Use Policy + AI disclaimer

---

## Anonymous Sessions & Slow Login (IMPLEMENTED v2.0)

### How It Works
1. **Automatic Visitor Tracking**: Every visitor gets a `hivv_visitor` cookie (90-day TTL)
2. **Usage Without Account**: Users can make API requests without logging in
3. **Usage Tracking**: All requests are logged with visitor_id, even for anonymous users
4. **Link Anytime**: When users decide to register, their visitor_id links to their new account
5. **Claim Previous Usage**: Anonymous visits get merged into the user's account

### New Endpoints

```
GET  /api/visitor/id              - Get your anonymous visitor ID
GET  /api/auth/anonymous-history - Check how many anonymous visits you have
POST /api/auth/link-account       - Link anonymous visits to existing account
```

### Register/Login with Link

```javascript
// Register and link your anonymous visits
POST /api/auth/register
{
  "username": "myuser",
  "password": "mypassword",
  "link_visitor_id": "v_xxxxx"  // Optional - links your anonymous visits
}

// Login and link anonymous visits to existing account
POST /api/auth/login
{
  "username": "myuser",
  "password": "mypassword",
  "link_visitor_id": "v_xxxxx"  // Optional - claim anonymous visits
}
```

### Benefits
- **Try before commit**: Users can test the service without creating an account
- **Seamless upgrade**: When they register, their history follows them
- **Lower friction**: No forced registration walls
- **Usage analytics**: Know how many anonymous -> registered conversions happen

---

## Legal Fixes Applied (2026-08-24)

### Issues Found & Fixed
1. **False encryption claim** — donate.html said "stored encrypted" but keys are plaintext. Fixed to say "protected from public SQL queries."
2. **No Terms of Service** — Created /terms.html
3. **No Privacy Policy** — Created /privacy.html
4. **No Acceptable Use Policy** — Created /aup.html with AI content disclaimer
5. **No AI disclaimer** — Added disclaimer to chat section and all page footers
6. **Footer legal links** — Added ToS/Privacy/AUP links to all 5 HTML pages

### Remaining Legal Considerations
- **API keys still stored in plaintext** in the database. Consider encrypting at rest with a server-side key.
- **No cookie consent banner** — localStorage used for agent ID, signed cookies for session. Consider adding consent.
- **No DMCA/copyright notice** — Add if content hosting expands.
- **Third-party ToS compliance** — Using donated keys to access OpenAI/Anthropic/etc. may violate their ToS. Consider adding donor responsibility disclaimer.
- **No data export** — Users can't export their data. Consider adding.
- **No account deletion** — Users can't delete their account. Consider adding.
- **Hardcoded DB password** in ecosystem.config.js — move to env var.
- **Hardcoded API keys** in server.js BUILTIN_KEYS — already overridable via env vars HIVV_MIMO_KEY, HIVV_MINIMAX_KEY.

---

## Future Enhancements

### Priority: High
- [x] Anonymous session tracking - visitors tracked by cookie, usage linked on register
- [x] Slow login - claim anonymous visits when registering
- [ ] Encrypt API keys at rest (use AES-256 with server-side master key)
- [ ] Add account deletion endpoint
- [ ] Add data export endpoint
- [ ] Add cookie consent mechanism
- [ ] Move DB password to environment variable only

### Priority: Medium
- [ ] Add OAuth/social login (Google, GitHub)
- [ ] Add 2FA support
- [ ] Add key rotation reminders (warn if key hasn't been used in 30 days)
- [ ] Add usage dashboard per user (how many calls, which providers)
- [ ] Add shared "teams" feature (multiple users share a key pool)
- [ ] Add API rate limiting per user (not just per IP)

### Priority: Low
- [ ] Add key encryption with user-derived key (zero-knowledge)
- [ ] Add webhook notifications for key quota exhaustion
- [ ] Add key usage analytics and cost estimation
- [ ] Add admin panel for managing users and keys
- [ ] Add audit log for auth events

---

## OpenAI-Compatible Endpoint Reference

### For External Clients Connecting to HIVV.org

```
Base URL: https://hivv.org/v1
Auth: X-Session-Token header (get from /api/auth/login)
Models: GET /v1/models
Chat: POST /v1/chat/completions (OpenAI format)
```

### Python Example
```python
import openai
client = openai.OpenAI(
    base_url="https://hivv.org/v1",
    api_key="YOUR_SESSION_TOKEN"  # from /api/auth/login
)
response = client.chat.completions.create(
    model="mimo-v2.5-pro",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### curl Example
```bash
# Login first
TOKEN=$(curl -s -X POST https://hivv.org/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"mypassword"}' | jq -r .session_token)

# Chat
curl -N -X POST https://hivv.org/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: $TOKEN" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```
