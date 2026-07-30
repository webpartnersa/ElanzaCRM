const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'docket-portal.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,           -- 'admin' | 'merchandiser' | 'buyer'
    retailer TEXT,                -- scoping for buyer role, e.g. 'Pick n Pay'
    department TEXT               -- scoping for buyer role, e.g. 'Ladies'
  );

  CREATE TABLE IF NOT EXISTS styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_no TEXT UNIQUE NOT NULL,
    retailer TEXT NOT NULL,
    department TEXT NOT NULL,
    buyer TEXT,
    description TEXT,
    stage TEXT NOT NULL DEFAULT 'brief',
    fabric TEXT, colour TEXT, wash TEXT,
    units TEXT, target_rsp TEXT,
    cost TEXT, margin TEXT, factory TEXT,          -- merchandiser/admin-only fields
    first_ship TEXT, first_delivery TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES styles(id),
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES styles(id),
    path TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_no TEXT UNIQUE NOT NULL,
    department TEXT NOT NULL,
    description TEXT,
    source TEXT,               -- 'Buyer photo' | 'In-house sample' | 'Bought-in reference'
    tags TEXT,                 -- free-text, comma separated
    cost_estimate TEXT,
    factory TEXT,
    lead_time_note TEXT,
    favourite INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS concept_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id),
    path TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS concept_conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id),
    style_id INTEGER NOT NULL REFERENCES styles(id),
    style_no TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    redirect_uris TEXT NOT NULL,
    client_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    access_token TEXT PRIMARY KEY,
    refresh_token TEXT,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS containers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_no TEXT,
    vessel TEXT,
    container_type TEXT,          -- '20FT' | '40FT GP' | '40FT NOR' | '40FT HQ'
    notes TEXT,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Each row is one style's shipment. container_id IS NULL means it sits in
  -- the "Unassigned Orders" pool, awaiting a container.
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER REFERENCES containers(id),
    style_id INTEGER REFERENCES styles(id),
    style_no TEXT,
    description TEXT,
    cbm TEXT,
    order_no TEXT,
    po_delivery_date TEXT,
    ck_po_date TEXT,
    units TEXT,
    rsp TEXT,
    bailed INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    position TEXT NOT NULL,   -- 'Buyer' | 'Planner' | 'QC' | 'Other'
    phone TEXT,
    email TEXT,
    retailer TEXT NOT NULL,
    department TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Every time an order's shipment date (po_delivery_date) gets pushed out
  -- after already being set, one row is logged here with why - replaces the
  -- old "13 June was 6 June was 30 May..." run-on text the source spreadsheet
  -- used to track factory delays. Row count for an order = how many times
  -- its shipment date has slipped.
  CREATE TABLE IF NOT EXISTS order_delays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    old_date TEXT,
    new_date TEXT,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Base fabrics in use (e.g. code "3895"), each with its composition and
  -- lab approval report - the report is only valid 12 months from
  -- approval_date, computed at read time rather than stored, so there's
  -- nothing to keep in sync if the 12-month rule ever changes.
  CREATE TABLE IF NOT EXISTS fabrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    composition TEXT,
    report_number TEXT,
    approval_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Fields a buyer session is allowed to see. Everything else (cost, margin,
// factory) is stripped server-side before a buyer response is ever sent -
// this is the enforcement point, not the frontend.
const BUYER_VISIBLE_STYLE_FIELDS = [
  'id', 'style_no', 'retailer', 'department', 'buyer', 'description',
  'stage', 'fabric', 'colour', 'wash', 'units', 'target_rsp',
  'first_ship', 'first_delivery', 'updated_at', 'cover_photo'
];

// Adds a column to an existing table without touching any data, only if it
// isn't already there - safe to run every time the app starts.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added column ${column} to ${table}`);
  }
}
// Orders imported from the source ORDER SCHEDULE spreadsheet use an older
// style-numbering scheme (e.g. "ELA-PL021B") that doesn't correspond to any
// row in our own styles table, so style_id can't stay NOT NULL. SQLite can't
// ALTER a column's constraint in place, so this recreates the table with
// every existing column carried over as-is - idempotent (checked via
// PRAGMA table_info each startup), and a no-op once already migrated.
function ensureOrdersStyleIdNullable() {
  const info = db.prepare("PRAGMA table_info(orders)").all();
  const styleIdCol = info.find(c => c.name === 'style_id');
  if (!styleIdCol || styleIdCol.notnull === 0) return;
  console.log('Migrating orders.style_id to nullable...');
  const cols = info.map(c => {
    let def = c.name + ' ' + c.type;
    if (c.name === 'id') def += ' PRIMARY KEY AUTOINCREMENT';
    if (c.name === 'style_id') def += ' REFERENCES styles(id)';
    if (c.name === 'container_id') def += ' REFERENCES containers(id)';
    if (c.dflt_value !== null) def += ' DEFAULT ' + c.dflt_value;
    return def;
  });
  const colNames = info.map(c => c.name).join(', ');
  db.exec('PRAGMA foreign_keys=OFF;');
  db.transaction(() => {
    db.exec('CREATE TABLE orders_new (' + cols.join(', ') + ')');
    db.exec('INSERT INTO orders_new (' + colNames + ') SELECT ' + colNames + ' FROM orders');
    db.exec('DROP TABLE orders');
    db.exec('ALTER TABLE orders_new RENAME TO orders');
  })();
  db.exec('PRAGMA foreign_keys=ON;');
  console.log('orders.style_id is now nullable');
}
ensureOrdersStyleIdNullable();

ensureColumn('concept_photos', 'sort_order', 'INTEGER DEFAULT 0');
ensureColumn('concept_photos', 'role', "TEXT DEFAULT 'reference'"); // 'reference' | 'detail' | 'cad' | 'cad_detail'
ensureColumn('concept_photos', 'label', 'TEXT'); // used by 'cad_detail' photos, e.g. "BUTTON DETAIL"
// 200px-wide copy of `path`, generated at upload time (routes/concepts.js)
// so the board can show every card's cover photo without pulling down a
// full-size image per card. Null for photos uploaded before this existed -
// attachCoverPhoto falls back to the full path for those.
ensureColumn('concept_photos', 'thumb_path', 'TEXT');
ensureColumn('concepts', 'concept_date', 'TEXT');
ensureColumn('concepts', 'cad_description', 'TEXT');
// Replaces the old free-text 'lead_time_note' field (unused, kept as
// legacy rather than dropped) with a real date - "Shipping Date" is a
// specific date, not a note like "8 weeks ex-factory".
ensureColumn('concepts', 'shipping_date', 'TEXT');
ensureColumn('styles', 'concept_ref', 'TEXT');
ensureColumn('styles', 'cad_description', 'TEXT');
// Distinguishes a style's generated/uploaded CAD image from its ordinary
// reference photos - same convention as concept_photos.role.
ensureColumn('photos', 'role', "TEXT DEFAULT 'reference'");

// Shipping Schedule drawer fields beyond the core columns above - kept as a
// non-destructive extension rather than baked into the initial CREATE TABLE
// so the base schema stays readable. All free-text like the rest of the
// order/style fields (dates included - the frontend parses/formats them).
[
  'season', 'colour',
  'sent_to_factory', 'labdip', 'fabric_test', 'fit', 'preprod', 'preship',
  'po_price', 'rand_excl', 'roe', 'landed', 'profit', 'margin',
  'supp_inv', 'supp_inv_date', 'actual_dc', 'payment_due', 'invoice_value', 'elanza_paid'
].forEach(col => ensureColumn('orders', col, 'TEXT'));

// Full field parity with the source "ORDER SCHEDULE" spreadsheet (the sheet
// this whole Shipping Schedule feature was built from) - every column on its
// ORDERS sheet that wasn't already covered above. Free-text, same as the
// rest of this table - the sheet itself mixes dates, numbers and status
// words in these columns, so no stricter type would hold real data anyway.
[
  'rms_article_no', 'import_code',                              // J, K
  'cads',                                                        // Q
  'composition',                                                 // S
  'fabric_test_start', 'fabric_approved', 'fabric_sent_to_buyer',// U, V, W
  'po_cartons',                                                  // AA
  'rand_incl', 'est_lp', 'k_lp', 'factor', 'profit_per_item',    // AD, AE, AG, AH, AJ
  'total_rand_excl', 'total_rand_incl', 'total_dollar_value',    // AL, AM, AN
  'cents', 'pct', 'true_dollar_price',                           // AO, AP, AQ
  'true_cbm', 'true_cartons', 'finv',                            // AU, AV, AW
  'units_shipped', 'true_dollar_total',                          // AZ, BA
  'warehouse_packing_list', 'warehouse_work_done',                // BB, BD
  'payment_terms', 'pop_received_date',                          // BH, BJ
  'invoice_value_excl', 'discount_terms', 'addendum_discounts',  // BK, BM, BO
  'landed_roe', 'liverpool_payment_date',                        // BR, BV
  'elanza_inv', 'elanza_ttl_inv_paid'                            // BW, BX
].forEach(col => ensureColumn('orders', col, 'TEXT'));

// Container-level ETD/ETA - the sheet lists these once per shipment, not
// per style, so they belong on containers rather than duplicated per order.
['etd', 'eta'].forEach(col => ensureColumn('containers', col, 'TEXT'));

// Short factory-facing reference (e.g. "CK25"), separate from the fuller
// container_no ("CK25 - QSFD1153515") - easier to say on a call. Copied
// onto each order in that container (orders.container_code) so it's
// visible right in the grid without opening the container's own row -
// kept in sync on move/rename in routes/shipping.js, but still a plain
// editable column like the rest of the row.
ensureColumn('containers', 'code', 'TEXT');
ensureColumn('orders', 'container_code', 'TEXT');
// Links an order to the fabric it's cut from - selecting a fabric code in
// the order drawer autofills composition + fabric_test from here, it
// doesn't create a hard dependency (the copied values stay editable
// afterward, same convenience-autofill pattern as Contacts -> New Style).
ensureColumn('orders', 'fabric_code', 'TEXT');
// Transit tracking, separate from the `delivered` flag (which removes the
// container from the schedule entirely once its orders reach the retailer).
// This is a lighter-weight in-between status so a container's orders can be
// visibly marked on-the-water / landed-in-Durban while still sitting in the
// active schedule. Empty string = no status set. Values are 'on_water' or
// 'landed' - delivery itself is tracked per order below, not per container,
// since a landed container's orders don't all clear DC space on the same day.
ensureColumn('containers', 'transit_status', "TEXT DEFAULT ''");
// Per-order DC delivery status, set from the order drawer - 'delivered' or
// 'delayed'. Empty string = no status set.
ensureColumn('orders', 'dc_status', "TEXT DEFAULT ''");

// Read/unread tracking for the Notification Centre, per user. Notifications
// aren't stored rows - they're computed live from orders/fabrics - so a
// "read" record is keyed by a string that bakes in the alert's current
// value (delay_count, fabric approval_date). If that value changes later
// (another delay, a renewed approval date), the key changes too and the
// alert naturally reappears as unread with no separate invalidation logic.
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    notif_key TEXT NOT NULL,
    read_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, notif_key)
  );
`);

// Per-user section access (comma-separated: styles,concepts,shipping,
// contacts) - independent of role. Role still governs field-level scoping
// (buyers never see cost/margin, are locked to their own retailer+
// department) and edit rights (buyers can never create/edit/delete) -
// this only controls whether a section is visible/reachable at all.
ensureColumn('users', 'permissions', 'TEXT');
// One-time backfill so existing accounts keep exactly the access they had
// before this column existed: buyers could already reach Styles and
// Concepts (read-scoped) but were blocked from Shipping/Contacts; every
// other role could reach all four.
db.prepare("UPDATE users SET permissions = 'styles,concepts' WHERE role = 'buyer' AND (permissions IS NULL OR permissions = '')").run();
db.prepare("UPDATE users SET permissions = 'styles,concepts,shipping,contacts' WHERE role != 'buyer' AND (permissions IS NULL OR permissions = '')").run();
// 'fabrics' added after the column above already existed for some users -
// same backfill principle, run separately (and idempotently) so it reaches
// accounts created between the two changes without re-touching everyone.
db.prepare(`
  UPDATE users SET permissions = permissions || ',fabrics'
  WHERE role != 'buyer' AND permissions NOT LIKE '%fabrics%'
`).run();

function seed() {
  // Backfills concept_date for any concept created before this field
  // existed, using its original creation month/year. New concepts already
  // get this set automatically at creation time (see routes/concepts.js).
  db.prepare(`UPDATE concepts SET concept_date = substr(created_at, 1, 7) WHERE concept_date IS NULL OR concept_date = ''`).run();
  // Non-destructive migration: adds any columns this version of the app
  // needs but an older database doesn't have yet. Existing data untouched.
  ['season','raw_brief','topstitch','trims','styling','spec_notes','shipment_note','target_cost','image_path']
    .forEach(col => ensureColumn('styles', col, 'TEXT'));

  // One-time migration: any style with the old single image_path set, and
  // no rows in the new photos table yet, gets that photo carried over.
  const legacyPhotos = db.prepare(`SELECT id, image_path FROM styles WHERE image_path IS NOT NULL AND image_path != ''`).all();
  legacyPhotos.forEach(s => {
    const already = db.prepare('SELECT COUNT(*) c FROM photos WHERE style_id = ?').get(s.id).c;
    if (already === 0) {
      db.prepare('INSERT INTO photos (style_id, path) VALUES (?,?)').run(s.id, s.image_path);
    }
  });

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(
      `INSERT INTO users (name,email,password_hash,role,retailer,department) VALUES (?,?,?,?,?,?)`
    );
    insertUser.run('Vicky', 'vicky@elanzas.com', bcrypt.hashSync('uNHav5rtPbhcsP', 10), 'merchandiser', null, null);
    insertUser.run('Abbey Kilian', 'abbey@pnp.co.za', bcrypt.hashSync('H*yF!bN!j4f#XC', 10), 'buyer', 'Pick n Pay', 'Ladies');
    console.log('Seeded users');
  }

  // One-time upgrade path: if this database predates the admin role and no
  // admin exists yet, promote the first merchandiser found so there's
  // always at least one working way into user management.
  const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get().c;
  if (adminCount === 0) {
    const firstMerch = db.prepare(`SELECT id, name FROM users WHERE role = 'merchandiser' LIMIT 1`).get();
    if (firstMerch) {
      db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(firstMerch.id);
      console.log(`Promoted "${firstMerch.name}" to admin (no admin existed yet)`);
    }
  }

  const styleCount = db.prepare('SELECT COUNT(*) c FROM styles').get().c;
  if (styleCount === 0) {
    db.prepare(`
      INSERT INTO styles (style_no, retailer, department, buyer, description, stage,
        fabric, colour, wash, units, target_rsp, cost, margin, factory, first_ship, first_delivery)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'PL425', 'Pick n Pay', 'Ladies', 'Abbey Kilian',
      'Heart Embroidered Cropped Wide Leg Jeans', 'worksheet',
      'Denim', 'Mid Blue', 'Mid blue wash', '1690', '369.99',
      '178.50', '44.5%', 'Shi Shi Jiade Garments Production Co Ltd',
      '', ''
    );
    console.log('Seeded style PL425');
  }
}

seed();

module.exports = { db, BUYER_VISIBLE_STYLE_FIELDS };
