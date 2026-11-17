const bcrypt = require('bcryptjs');

function createAuthRoutes({ pool, sessions, getSession, getVisitorId, createSession, SESSION_TTL, csrfValidate, requireAuth, cache }) {
    const express = require('express');
    const router = express.Router();

    async function getAnonymousVisitCount(visitorId) {
        try {
            const result = await pool.query(
                'SELECT COUNT(*) as count FROM usage_logs WHERE anonymous_visitor_id = $1',
                [visitorId]
            );
            return parseInt(result.rows[0].count);
        } catch {
            return 0;
        }
    }

    router.post('/register', async (req, res) => {
        const { username, password, email, display_name, link_visitor_id } = req.body;
        if (!username || !password) {return res.status(400).json({ error: 'username and password required' });}
        if (username.length < 3 || username.length > 50) {return res.status(400).json({ error: 'username must be 3-50 characters' });}
        if (password.length < 6) {return res.status(400).json({ error: 'password must be at least 6 characters' });}
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {return res.status(400).json({ error: 'username may only contain letters, numbers, hyphens, and underscores' });}

        try {
            const existing = await pool.query('SELECT id, visitor_id FROM users WHERE username = $1', [username.toLowerCase()]);
            if (existing.rows.length > 0) {
                if (existing.rows[0].visitor_id && link_visitor_id && existing.rows[0].visitor_id === link_visitor_id) {
                    return res.status(409).json({
                        error: 'This visitor session is already linked to an account. Please login instead.',
                        code: 'ALREADY_LINKED',
                        hint: 'Use /api/auth/login to access your account'
                    });
                }
                return res.status(409).json({ error: 'username already taken' });
            }

            const hash = await bcrypt.hash(password, 12);

            const result = await pool.query(
                'INSERT INTO users (username, password_hash, email, display_name, role, visitor_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, display_name, role, created_at',
                [username.toLowerCase(), hash, email || null, display_name || username, 'user', link_visitor_id || null]
            );

            const user = result.rows[0];
            const token = await createSession(user.id, user.username, user.role);

            if (link_visitor_id) {
                await pool.query(
                    'UPDATE anonymous_sessions SET user_id = $1, last_seen_at = NOW() WHERE visitor_id = $2',
                    [user.id, link_visitor_id]
                );
                await pool.query(
                    'UPDATE usage_logs SET user_id = $1 WHERE anonymous_visitor_id = $2 AND user_id IS NULL',
                    [user.id, link_visitor_id]
                );
            }

            res.cookie('hivv_session', token, { signed: true, httpOnly: true, maxAge: SESSION_TTL, sameSite: 'lax' });
            res.json({
                success: true,
                user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
                session_token: token,
                linked_visits: link_visitor_id ? await getAnonymousVisitCount(link_visitor_id) : 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/login', async (req, res) => {
        const { username, password, link_visitor_id } = req.body;
        if (!username || !password) {return res.status(400).json({ error: 'username and password required' });}

        try {
            const result = await pool.query(
                'SELECT id, username, password_hash, display_name, role, is_active, visitor_id FROM users WHERE username = $1',
                [username.toLowerCase()]
            );
            if (result.rows.length === 0) {return res.status(401).json({ error: 'invalid username or password' });}

            const user = result.rows[0];
            if (!user.is_active) {return res.status(401).json({ error: 'account is disabled' });}

            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) {return res.status(401).json({ error: 'invalid username or password' });}

            await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

            if (link_visitor_id && !user.visitor_id) {
                await pool.query(
                    'UPDATE anonymous_sessions SET user_id = $1, last_seen_at = NOW() WHERE visitor_id = $2',
                    [user.id, link_visitor_id]
                );
                await pool.query(
                    'UPDATE usage_logs SET user_id = $1 WHERE anonymous_visitor_id = $2 AND user_id IS NULL',
                    [user.id, link_visitor_id]
                );
                await pool.query('UPDATE users SET visitor_id = $1 WHERE id = $2 AND visitor_id IS NULL', [link_visitor_id, user.id]);
            }

            const token = await createSession(user.id, user.username, user.role);
            res.cookie('hivv_session', token, { signed: true, httpOnly: true, maxAge: SESSION_TTL, sameSite: 'lax' });
            res.json({
                success: true,
                user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
                session_token: token,
                linked_visits: link_visitor_id ? await getAnonymousVisitCount(link_visitor_id) : 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/logout', async (req, res) => {
        const token = req.signedCookies?.hivv_session || req.headers['x-session-token'];
        if (token) {
            sessions.delete(token); // Remove from cache
            try {
                await pool.query('DELETE FROM sessions WHERE token = $1', [token]); // Remove from DB
            } catch (err) {
                console.error('Logout DB cleanup error:', err.message);
            }
        }
        res.clearCookie('hivv_session');
        res.json({ success: true });
    });

    router.post('/change-password', csrfValidate, async (req, res) => {
        const session = await getSession(req);
        if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}

        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'current_password and new_password required' });
        }

        if (new_password.length < 6) {
            return res.status(400).json({ error: 'new password must be at least 6 characters' });
        }

        try {
            const result = await pool.query(
                'SELECT id, password_hash FROM users WHERE id = $1',
                [session.userId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            const user = result.rows[0];
            const valid = await bcrypt.compare(current_password, user.password_hash);
            if (!valid) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }

            const newHash = await bcrypt.hash(new_password, 12);
            await pool.query(
                'UPDATE users SET password_hash = $1 WHERE id = $2',
                [newHash, session.userId]
            );

            // Invalidate all other sessions for this user (security best practice)
            await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [session.userId, req.signedCookies?.hivv_session || req.headers['x-session-token']]);

            res.json({ success: true, message: 'Password changed successfully. Other sessions have been logged out.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/reset-password', async (req, res) => {
        const { username, email } = req.body;
        if (!username || !email) {
            return res.status(400).json({ error: 'username and email required' });
        }

        try {
            const result = await pool.query(
                'SELECT id FROM users WHERE username = $1 AND email = $2',
                [username.toLowerCase(), email.toLowerCase()]
            );

            if (result.rows.length === 0) {
                return res.json({ success: true, message: 'If an account matches, a reset email would be sent' });
            }

            res.json({ success: true, message: 'Password reset not yet implemented. Contact admin.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/account', csrfValidate, async (req, res) => {
        const session = await getSession(req);
        if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}

        const { current_password } = req.body;
        if (!current_password) {
            return res.status(400).json({ error: 'current_password required for account deletion' });
        }

        try {
            const result = await pool.query(
                'SELECT id, password_hash FROM users WHERE id = $1',
                [session.userId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            const user = result.rows[0];
            const valid = await bcrypt.compare(current_password, user.password_hash);
            if (!valid) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }

            await pool.query('DELETE FROM sessions WHERE user_id = $1', [session.userId]);
            await pool.query('DELETE FROM usage_logs WHERE user_id = $1', [session.userId]);
            await pool.query('DELETE FROM ai_keys WHERE user_id = $1', [session.userId]);
            await pool.query('DELETE FROM user_quotas WHERE user_id = $1', [session.userId]);
            await pool.query('DELETE FROM anonymous_sessions WHERE user_id = $1', [session.userId]);
            await pool.query('DELETE FROM users WHERE id = $1', [session.userId]);

            res.clearCookie('hivv_session');
            res.json({ success: true, message: 'Account and all associated data have been deleted' });
        } catch (err) {
            console.error('Account deletion error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/profile', csrfValidate, async (req, res) => {
        const session = await getSession(req);
        if (!session) {return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });}

        const { username, display_name, email, current_password, new_password } = req.body;

        try {
            const updates = [];
            const params = [];
            let paramIndex = 1;

            if (username !== undefined && username !== session.username) {
                if (username.length < 3 || username.length > 50) {
                    return res.status(400).json({ error: 'username must be 3-50 characters' });
                }
                if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
                    return res.status(400).json({ error: 'username may only contain letters, numbers, hyphens, and underscores' });
                }
                const existing = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username.toLowerCase(), session.userId]);
                if (existing.rows.length > 0) {
                    return res.status(409).json({ error: 'username already taken' });
                }
                updates.push(`username = $${paramIndex}`);
                params.push(username.toLowerCase());
                paramIndex++;
            }

            if (display_name !== undefined) {
                updates.push(`display_name = $${paramIndex}`);
                params.push(display_name);
                paramIndex++;
            }

            if (email !== undefined) {
                updates.push(`email = $${paramIndex}`);
                params.push(email);
                paramIndex++;
            }

            if (new_password !== undefined) {
                if (!current_password) {
                    return res.status(400).json({ error: 'current_password required to change password' });
                }
                if (new_password.length < 6) {
                    return res.status(400).json({ error: 'password must be at least 6 characters' });
                }
                const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [session.userId]);
                const valid = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
                if (!valid) {
                    return res.status(401).json({ error: 'Current password is incorrect' });
                }
                const hash = await bcrypt.hash(new_password, 12);
                updates.push(`password_hash = $${paramIndex}`);
                params.push(hash);
                paramIndex++;
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            params.push(session.userId);
            const result = await pool.query(
                `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, display_name, email`,
                params
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ success: true, user: result.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/me', async (req, res) => {
        const session = await getSession(req);
        const visitorId = getVisitorId(req, res);

        if (session) {
            return res.json({
                logged_in: true,
                user: { id: session.userId, username: session.username, role: session.role },
                visitor_id: visitorId,
                has_anonymous_history: false
            });
        }

        res.json({
            logged_in: false,
            visitor_id: visitorId,
            has_anonymous_history: false
        });
    });

    router.get('/export', requireAuth, async (req, res) => {
        const session = await getSession(req);

        try {
            const [userResult, keysResult, usageResult] = await Promise.all([
                pool.query('SELECT id, username, display_name, email, role, created_at, last_login_at FROM users WHERE id = $1', [session.userId]),
                pool.query('SELECT provider_id, key_name, model, priority, is_active, is_shared, created_at FROM ai_keys WHERE user_id = $1', [session.userId]),
                pool.query(`
                    SELECT u.provider_id, u.model, u.input_tokens, u.output_tokens, u.total_tokens, u.cost, u.latency_ms, u.status, u.created_at,
                           p.name as provider_name
                    FROM usage_logs u
                    LEFT JOIN ai_providers p ON u.provider_id = p.id
                    WHERE u.user_id = $1
                    ORDER BY u.created_at DESC
                    LIMIT 1000
                `, [session.userId])
            ]);

            const exportData = {
                exported_at: new Date().toISOString(),
                user: userResult.rows[0],
                api_keys: keysResult.rows,
                usage_history: usageResult.rows,
                summary: {
                    total_api_keys: keysResult.rows.length,
                    total_usage_records: usageResult.rows.length,
                    total_input_tokens: usageResult.rows.reduce((sum, r) => sum + (r.input_tokens || 0), 0),
                    total_output_tokens: usageResult.rows.reduce((sum, r) => sum + (r.output_tokens || 0), 0),
                    total_cost: usageResult.rows.reduce((sum, r) => sum + parseFloat(r.cost || 0), 0)
                }
            };

            res.json(exportData);
        } catch (err) {
            console.error('Export error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/anonymous-history', async (req, res) => {
        const visitorId = getVisitorId(req, res);
        const session = await getSession(req);

        if (session) {
            return res.json({ logged_in: true, anonymous_visits: 0 });
        }

        if (!visitorId) {
            return res.json({ anonymous_visits: 0 });
        }

        pool.query(
            'SELECT COUNT(*) as count FROM usage_logs WHERE anonymous_visitor_id = $1',
            [visitorId]
        ).then(result => {
            res.json({
                anonymous_visits: parseInt(result.rows[0].count)
            });
        }).catch(() => {
            res.json({ anonymous_visits: 0 });
        });
    });

    router.post('/link-account', async (req, res) => {
        const { username, password, link_visitor_id } = req.body;
        if (!username || !password) {return res.status(400).json({ error: 'username and password required' });}

        const session = await getSession(req);
        if (session) {return res.status(400).json({ error: 'Already logged in' });}

        try {
            const result = await pool.query(
                'SELECT id, username, password_hash, display_name, role, is_active, visitor_id FROM users WHERE username = $1',
                [username.toLowerCase()]
            );
            if (result.rows.length === 0) {return res.status(401).json({ error: 'invalid username or password' });}

            const user = result.rows[0];
            if (!user.is_active) {return res.status(401).json({ error: 'account is disabled' });}

            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) {return res.status(401).json({ error: 'invalid username or password' });}

            if (link_visitor_id) {
                await pool.query(
                    'UPDATE anonymous_sessions SET user_id = $1, last_seen_at = NOW() WHERE visitor_id = $2',
                    [user.id, link_visitor_id]
                );
                await pool.query(
                    'UPDATE usage_logs SET user_id = $1 WHERE anonymous_visitor_id = $2 AND user_id IS NULL',
                    [user.id, link_visitor_id]
                );
            }

            const token = await createSession(user.id, user.username, user.role);
            res.cookie('hivv_session', token, { signed: true, httpOnly: true, maxAge: SESSION_TTL, sameSite: 'lax' });
            res.json({
                success: true,
                user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
                session_token: token
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}

module.exports = { createAuthRoutes };
