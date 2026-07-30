require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));
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
app.use('/api/shipping', require('./routes/shipping'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/fabrics', require('./routes/fabrics'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin/users', require('./routes/users'));
app.use('/mcp', require('./routes/mcp'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Docket portal running on port ${PORT}`));
