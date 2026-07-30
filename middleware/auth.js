function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
  next();
}

// Per-user section access, independent of role - see db.js's users.permissions
// column comment. Role still governs field-level scoping and edit rights;
// this only governs whether a section is reachable at all.
function hasPermission(user, section) {
  return (user.permissions || '').split(',').filter(Boolean).includes(section);
}
function requirePermission(section) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!hasPermission(req.session.user, section)) return res.status(403).json({ error: 'Not authorized for this section' });
    next();
  };
}

module.exports = { requireAuth, requireAdmin, hasPermission, requirePermission };
