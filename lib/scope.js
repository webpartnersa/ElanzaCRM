const { BUYER_VISIBLE_STYLE_FIELDS } = require('../db');

// 'buyer' is the only restricted role. Both 'admin' and 'merchandiser' see
// full style data - admin's extra power is user management, not style access.
function scopeStyleForRole(style, user) {
  if (user.role !== 'buyer') return style;
  const scoped = {};
  BUYER_VISIBLE_STYLE_FIELDS.forEach(f => { scoped[f] = style[f]; });
  return scoped;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, retailer: u.retailer, department: u.department, permissions: u.permissions || '' };
}

module.exports = { scopeStyleForRole, publicUser };
