const crypto = require('crypto');
const express = require('express');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
);
const EXTERNAL_URL = (process.env.EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const REQUIRE_AUTH = !['false', '0', 'no'].includes(
  (process.env.REQUIRE_AUTH || 'true').toLowerCase()
);

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

function googleRedirectUri() {
  return `${EXTERNAL_URL}/login/google/callback`;
}

function requireAuth(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  if (req.session && req.session.user) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login');
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Capture URLs</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #0f1117;
           display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .box { background: #1e2433; border-radius: 10px; padding: 40px 36px;
           max-width: 340px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
    h1 { font-size: 1.25em; margin-bottom: 28px; text-align: center; color: #f8fafc; }
    .btn-google { display: block; background: #4285F4; color: white;
                  padding: 12px 20px; border-radius: 6px; text-decoration: none;
                  text-align: center; font-size: 0.95em; font-weight: 500; }
    .btn-google:hover { background: #3367D6; }
    .error { color: #fc8181; margin-top: 16px; text-align: center; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Capture URLs</h1>
    {{google_button}}
    {{error_block}}
  </div>
</body>
</html>`;

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  const error = req.session ? req.session.loginError : null;
  if (req.session) delete req.session.loginError;

  const googleButton = GOOGLE_ENABLED
    ? '<a href="/login/google" class="btn-google">Sign in with Google</a>'
    : "<p style='color:#94a3b8;text-align:center'>Google auth not configured.</p>";
  const errorBlock = error ? `<div class="error">${error}</div>` : '';

  res.set('Content-Type', 'text/html').send(
    LOGIN_HTML.replace('{{google_button}}', googleButton).replace('{{error_block}}', errorBlock)
  );
});

router.get('/login/google', (req, res) => {
  if (!GOOGLE_ENABLED) {
    return res.status(400).json({ error: 'Google auth not configured' });
  }
  const state = crypto.randomBytes(16).toString('base64url');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

router.get('/login/google/callback', async (req, res) => {
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;

  if (req.query.state !== expectedState) {
    req.session.loginError = 'Invalid OAuth state. Please try again.';
    return res.redirect('/login');
  }

  const code = req.query.code;
  if (!code) {
    req.session.loginError = 'Google sign-in failed (no code).';
    return res.redirect('/login');
  }

  let userinfo;
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }
    const tokenData = await tokenRes.json();

    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) {
      throw new Error(`Userinfo fetch failed: ${userRes.status}`);
    }
    userinfo = await userRes.json();
  } catch (err) {
    req.session.loginError = `Google sign-in error: ${err.message}`;
    return res.redirect('/login');
  }

  const email = userinfo.email || '';

  if (!userinfo.email_verified) {
    req.session.loginError = 'Google account email is not verified.';
    return res.redirect('/login');
  }

  if (ALLOWED_EMAILS.size > 0 && !ALLOWED_EMAILS.has(email)) {
    req.session.loginError = `Access denied for ${email}.`;
    return res.redirect('/login');
  }

  req.session.user = email;
  res.redirect('/');
});

router.get('/auth/check', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.session.user });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = { router, requireAuth, REQUIRE_AUTH, GOOGLE_ENABLED };
