require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
// Mounted before express.json() below - the webhook route inside needs the
// exact raw request bytes for Svix signature verification, which
// express.json() would otherwise consume (and not preserve) first.
app.use('/api/inbound', require('./routes/inboundEmail'));
app.use(express.json({ limit: '15mb' }));
// The mobile PWA (installed to a phone's home screen) has no version/hash
// in its script tag (see public/mobile/index.html) and no cache-busting
// scheme at all, so a phone browser can hang onto a stale app.js/index.html
// indefinitely after a deploy - a real recurring problem, not one-off.
// no-cache (not no-store) still lets the browser cache the file, it just
// forces a revalidation request every time rather than trusting a stale
// local copy, so this doesn't add real load for what's already a small file.
app.use('/mobile', (req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, maxAge: 1000 * 60 * 60 * 8 } // 8 hour session
}));

// Each section of the app lives in its own route file - edit one section
// without touching the others.
app.use(require('./routes/oauth'));
app.use('/api', require('./routes/auth'));
app.use('/api/styles', require('./routes/styles'));
app.use('/api/concepts', require('./routes/concepts'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/spec-categories', require('./routes/specCategories'));
app.use('/api/size-ranges', require('./routes/sizeRanges'));
app.use('/api/shipping', require('./routes/shipping'));
app.use('/api/shipping', require('./routes/finalSubmission'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/factories', require('./routes/factories'));
app.use('/api/fabrics', require('./routes/fabrics'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/admin/users', require('./routes/users'));
app.use('/api/admin', require('./routes/adminReset'));
app.use('/mcp', require('./routes/mcp'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Docket portal running on port ${PORT}`));
