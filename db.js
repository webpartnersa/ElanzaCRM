const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'docket-portal.db'));
db.pragma('journal_mode = WAL');

// One-time rename: this table started out cost-request-only
// (concept_quotation_requests) and has grown into a general factory
// communication log (cost/sample/PP sample/bulk sample/fabric test - see
// request_type below). Has to run before the schema block's own
// "CREATE TABLE IF NOT EXISTS concept_requests" so an existing install's
// real sent-request history gets renamed onto rather than orphaned under
// the old name once that statement creates a fresh empty table under the
// new one.
(function renameQuotationRequestsTable() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('concept_quotation_requests','concept_requests')").all().map(r => r.name);
  if (tables.includes('concept_quotation_requests') && !tables.includes('concept_requests')) {
    db.exec('ALTER TABLE concept_quotation_requests RENAME TO concept_requests');
    console.log('Renamed concept_quotation_requests to concept_requests');
  }
})();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,           -- 'admin' | 'merchandiser' | 'buyer'
    retailer TEXT,                -- scoping for buyer role, e.g. 'PnP' (see RETAILERS in public/js/board.js)
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

  -- Self-referencing tree used to build the Concepts drawer's cascading
  -- "Spec" picker: root nodes (parent_id NULL) are the top-level categories
  -- under one department (e.g. Ladies -> Denim), children nest to whatever
  -- depth is needed (Denim -> Skinny), and the deepest node a concept picks
  -- is stored as concepts.spec_category_id. A leaf's actual point-of-measure
  -- bank lives in spec_category_poms below.
  CREATE TABLE IF NOT EXISTS spec_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    parent_id INTEGER REFERENCES spec_categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- The reference measurement bank for a leaf spec category (e.g. "Denim
  -- Shorts") - one row per point of measure (e.g. "1/2 WAIST RELAXED") with
  -- its target "spec to be" value, in the order they appear on the buyer's
  -- appraisal sheet. Copied onto a style (see style_spec_poms) the moment
  -- that style picks this category, rather than referenced live, so a later
  -- correction to the bank doesn't silently rewrite a spec a factory is
  -- already quoting or fitting against.
  CREATE TABLE IF NOT EXISTS spec_category_poms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_category_id INTEGER NOT NULL REFERENCES spec_categories(id),
    name TEXT NOT NULL,
    spec_to_be TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- A style's own copy of its spec category's POM bank at the moment it was
  -- picked (see styles.spec_category_id, ensured further down) - frozen,
  -- not a live reference, for the same reason spec_category_poms itself
  -- isn't read live elsewhere.
  CREATE TABLE IF NOT EXISTS style_spec_poms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES styles(id),
    name TEXT NOT NULL,
    spec_to_be TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- One row per style per fit stage (1st Fit / 2nd Fit / Seal-PPS - see the
  -- fixed SPEC_FIT_STAGES list in routes/styles.js) - the merchandiser fills
  -- this in, once per stage, either by typing values in by hand or
  -- uploading the buyer's filled fit sheet (file_path/source record which).
  -- Re-recording a stage replaces its values rather than adding a second
  -- row, since there's only ever one "current" measurement per style per
  -- stage - UNIQUE enforces that.
  CREATE TABLE IF NOT EXISTS style_spec_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES styles(id),
    stage TEXT NOT NULL,
    fit_date TEXT,
    notes TEXT,
    source TEXT DEFAULT 'manual',
    file_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(style_id, stage)
  );
  CREATE TABLE IF NOT EXISTS style_spec_fit_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fit_id INTEGER NOT NULL REFERENCES style_spec_fits(id),
    pom_id INTEGER NOT NULL REFERENCES style_spec_poms(id),
    actual_value TEXT,
    UNIQUE(fit_id, pom_id)
  );

  -- Named, ordered size sets (e.g. "S / M / L" or "S / M / L / XL") that a
  -- concept picks one of via concepts.size_range_id - lets each concept use
  -- whichever size breakdown actually applies instead of free-typed sizes.
  CREATE TABLE IF NOT EXISTS size_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS size_range_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    size_range_id INTEGER NOT NULL REFERENCES size_ranges(id),
    value TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS concept_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id),
    path TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Extra fabric slots for a multi-piece concept (e.g. a dungaree + t-shirt
  -- set needs two fabrics). The concept's own fabric_code/composition/
  -- weight columns remain the first/primary fabric, kept as its own
  -- individually-visible values (not merged into anything live) - this
  -- table only holds any fabric beyond that one, added via "+ Add Fabric"
  -- in the drawer, each with its own composition/weight shown separately
  -- for the same reason. prefix labels which piece a slot belongs to (e.g.
  -- "T-Shirt") so a combined "Dungaree: ... / T-Shirt: ..." string can be
  -- built wherever one's actually needed (export, etc), without the app
  -- itself ever merging the fields together in the UI or the database.
  -- composition/weight are snapshotted here at pick time (same as the
  -- concept's own fields are), so they stay editable/frozen rather than
  -- drifting if the fabric's own test-report values change later.
  CREATE TABLE IF NOT EXISTS concept_fabrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id),
    prefix TEXT,
    fabric_code TEXT,
    composition TEXT,
    weight TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS concept_conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id),
    style_id INTEGER NOT NULL REFERENCES styles(id),
    style_no TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- One row per factory communication sent from a concept - cost/quotation
  -- requests, sample requests, PP sample requests, bulk sample requests,
  -- fabric test report requests (see routes/requests.js's send-request
  -- route, and REQUEST_TYPES in lib/conceptCostingTranslate.js for the
  -- fixed type list). The whole point is an audit trail of what was
  -- actually sent to a factory and when - concept_no/concept_description
  -- are snapshotted here rather than joined live, same reasoning as
  -- concept_conversions.style_no: the concept's own fields can keep
  -- changing after the fact without rewriting history. The html column is
  -- the exact rendered email body (photos included, as base64 data URIs)
  -- so "view the email content" later shows precisely what the factory
  -- received, not a re-render that could drift if the concept was edited
  -- since. message is only set for the non-cost types (cost requests build
  -- their body from the concept's own Details/Costing fields instead - see
  -- lib/conceptCostingEmailHtml.js), kept alongside html so a reminder
  -- email can reference what was actually asked for in plain text.
  CREATE TABLE IF NOT EXISTS concept_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id),
    concept_no TEXT NOT NULL,
    concept_description TEXT,
    request_type TEXT NOT NULL DEFAULT 'cost',
    message TEXT,
    sent_to TEXT NOT NULL,
    sent_by_name TEXT,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    resend_id TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting',
    received_at TEXT,
    reminder_count INTEGER NOT NULL DEFAULT 0,
    last_reminder_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Every individual reminder nudge sent for a request - concept_requests'
  -- own reminder_count/last_reminder_at only ever kept the tally and the
  -- most recent date, not the full history of when each one went out. One
  -- row per send, same "row count = how many times" pattern as order_delays
  -- above. sent_by_name mirrors concept_requests.sent_by_name (whoever
  -- clicked Remind, not necessarily who sent the original request).
  CREATE TABLE IF NOT EXISTS request_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES concept_requests(id),
    sent_by_name TEXT,
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

  -- A voice/chat caller who verified their PIN (see routes/mcp.js's
  -- identify_user_by_pin) gets one of these in exchange - every other MCP
  -- tool then requires it, so the call is authenticated as that specific
  -- user for its duration, same idea as oauth_tokens above but issued by
  -- PIN instead of OAuth. Deliberately short-lived (see expires_at, set at
  -- issue time) since it's the only thing standing between a bare MCP_TOKEN/
  -- OAuth connection and acting as a real named person.
  CREATE TABLE IF NOT EXISTS mcp_pin_sessions (
    token TEXT PRIMARY KEY,
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

  -- Factories used to just be a handful of Contacts rows tagged
  -- position='Factory' with a free-text 'company' name, mixed in with buyer/
  -- planner/QC contacts (see routes/contacts.js). This is the real entity -
  -- name is Elanzas' own internal reference name (what concepts.factory/
  -- styles.factory free text gets matched against), registered_name is the
  -- factory's actual legal/registered name (what would go on official
  -- paperwork like a Material Submission form). The people who work there
  -- stay as ordinary 'contacts' rows (still position='Factory'), just linked
  -- via factory_id below instead of a loosely-typed matching company string.
  CREATE TABLE IF NOT EXISTS factories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    registered_name TEXT,
    address TEXT,
    certifications TEXT,
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

  -- Base fabrics in use (e.g. code "3895") - just the code, composition and
  -- weight (oz). Everything report-specific (approval dates, report
  -- numbers, style/buyer, validity) lives per-report on
  -- fabric_test_reports instead, since a fabric can have many reports over
  -- time and the fabrics row itself isn't the place to track any one of them.
  CREATE TABLE IF NOT EXISTS fabrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    composition TEXT,
    weight TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Full history of every lab test report ever uploaded for a fabric code -
  -- a fabric gets retested per style/order over time, so this keeps every
  -- past report (with its extracted data and the original PDF) rather than
  -- only the single "current" report_number/approval_date kept on fabrics
  -- itself (which this table's most recent row for a code keeps in sync).
  CREATE TABLE IF NOT EXISTS fabric_test_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fabric_code TEXT NOT NULL,
    file_path TEXT NOT NULL,
    report_number TEXT,
    style_no TEXT,
    end_buyer TEXT,
    sample_description TEXT,
    report_date TEXT,
    testing_period_start TEXT,
    testing_period_end TEXT,
    weight_gsm TEXT,
    weight_oz TEXT,
    composition TEXT,
    overall_result TEXT,
    report_type TEXT DEFAULT 'base',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- One report can cover multiple styles - the same fabric is often tested
  -- once and used across e.g. "PG054/PG061" - so this is a many-to-many
  -- join, not a single column. Populated automatically from each report's
  -- style_no free text (see routes/fabrics.js's relinkReportStyles), plus
  -- manual link/unlink from a style's own Fabric Report tab.
  CREATE TABLE IF NOT EXISTS fabric_report_styles (
    report_id INTEGER NOT NULL REFERENCES fabric_test_reports(id) ON DELETE CASCADE,
    style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
    PRIMARY KEY (report_id, style_id)
  );

  -- Raised when a newly-uploaded report's fabric code already exists but its
  -- composition or weight doesn't match what's on file (see routes/fabrics.js's
  -- POST /test-reports) - unlike the Notification Centre's other alerts,
  -- this describes a one-time event at upload time, not a re-derivable
  -- current state, so it has to be a real stored row rather than computed
  -- fresh from current data each time.
  CREATE TABLE IF NOT EXISTS fabric_report_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fabric_code TEXT NOT NULL,
    report_id INTEGER REFERENCES fabric_test_reports(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- The Final Submission bundle PnP requires per order (see
  -- routes/finalSubmission.js) - one row per doc slot, matching the fixed
  -- list PnP's own "BULK SUBMISSION CHECKLIST" spreadsheet defines (see
  -- DOC_TYPES there): sap_po, bulk_audit_report, graded_spec, aql_report,
  -- fabric_test_report, sample_appraisal_report, third_party_report,
  -- data_sheet. UNIQUE(order_id, doc_type) - re-uploading/regenerating a
  -- slot replaces its row rather than adding a second, same reasoning as
  -- style_spec_fits' one-row-per-stage. file_path is relative to the
  -- private submissions dir (see resolvePrivatePath in
  -- routes/finalSubmission.js) - never under public/ or /uploads, so it's
  -- never web-reachable by URL guess, only through an authenticated route.
  CREATE TABLE IF NOT EXISTS order_submission_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'uploaded',
    file_path TEXT NOT NULL,
    original_filename TEXT,
    uploaded_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_id, doc_type)
  );
`);

// One-time backfill: auto-link every already-uploaded report to every style
// whose number appears in its (possibly multi-code, e.g. "PG054/PG061")
// style_no text - idempotent (INSERT OR IGNORE), safe to run on every
// startup, so reports uploaded before this feature existed still show up
// under their styles without needing to be re-uploaded.
(function backfillFabricReportStyles() {
  const styles = db.prepare('SELECT id, style_no FROM styles').all();
  const reports = db.prepare("SELECT id, style_no FROM fabric_test_reports WHERE style_no IS NOT NULL AND style_no != ''").all();
  const insert = db.prepare('INSERT OR IGNORE INTO fabric_report_styles (report_id, style_id) VALUES (?, ?)');
  reports.forEach(r => {
    const tokens = r.style_no.split(/[/,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    styles.forEach(s => {
      if (tokens.includes((s.style_no || '').toUpperCase())) insert.run(r.id, s.id);
    });
  });
})();

// One-time backfill: every style now gets its order row at creation time
// (see routes/styles.js's POST '/'), not only once it reaches the 'po'
// stage - this catches every style created before that change, so styles
// already sitting in Brief In/Doc Sent/Costed/Worksheet In/Proceed Sent
// show up in the Shipping Schedule immediately too, without needing to be
// re-saved. Idempotent (only inserts where no order exists for that style
// yet), safe to run on every startup.
(function backfillOrdersForStyles() {
  const styles = db.prepare('SELECT * FROM styles').all();
  const hasOrder = db.prepare('SELECT 1 FROM orders WHERE style_id = ?');
  const insert = db.prepare(`
    INSERT INTO orders (style_id, style_no, description, units, rsp, season, colour, container_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  styles.forEach(s => {
    if (!hasOrder.get(s.id)) {
      insert.run(s.id, s.style_no, s.description, s.units, s.target_rsp, s.season, s.colour);
    }
  });
})();

// Which earlier report a fabric_report_flags row's composition/weight
// dispute was raised against - lets the Notification Centre link straight
// to both PDFs (see routes/fabrics.js's POST /test-reports and GET
// /report-flags). Added after the table already existed, so backfilled
// below for any flag raised before this column did.
ensureColumn('fabric_report_flags', 'old_report_id', 'INTEGER');
(function backfillFlagOldReportIds() {
  const flags = db.prepare('SELECT id, fabric_code, report_id, created_at FROM fabric_report_flags WHERE old_report_id IS NULL').all();
  const findPrior = db.prepare(`
    SELECT id FROM fabric_test_reports
    WHERE fabric_code = ? AND id != ? AND created_at <= ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  const update = db.prepare('UPDATE fabric_report_flags SET old_report_id = ? WHERE id = ?');
  flags.forEach(f => {
    const prior = findPrior.get(f.fabric_code, f.report_id, f.created_at);
    if (prior) update.run(prior.id, f.id);
  });
})();

// Fields a buyer session is allowed to see. Everything else (cost, margin,
// factory) is stripped server-side before a buyer response is ever sent -
// this is the enforcement point, not the frontend. Mirrors which fields the
// Details tab itself hides from buyers (public/js/drawer.js) - factory,
// shipping_date and dc_date are wrapped in a canEdit check there and must
// stay off this list too, or the frontend hiding would be cosmetic only.
// target_rsp stays even though the Details tab no longer edits it - it's
// still shown read-only on the Style Pipeline board card.
const BUYER_VISIBLE_STYLE_FIELDS = [
  'id', 'style_no', 'retailer', 'department', 'buyer', 'description', 'stage',
  'fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
  'topstitch', 'trims', 'styling', 'units', 'size_range_id', 'packing', 'labels', 'source', 'tags', 'concept_date',
  'target_rsp', 'first_ship', 'first_delivery', 'updated_at', 'cover_photo'
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
function dropColumnIfExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    console.log(`Dropped column ${column} from ${table}`);
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

// Contacts started as buyer-side only (retailer+department both required -
// see the position/retailer/department scoping in routes/contacts.js), but
// factory contacts (for the costing-request send-by-email feature) don't
// have either - they get a free-text company name instead (the new
// `company` column below). Same table-rebuild technique as
// ensureOrdersStyleIdNullable, for the same reason (SQLite can't drop a
// NOT NULL constraint in place).
function ensureContactsRetailerDeptNullable() {
  const info = db.prepare("PRAGMA table_info(contacts)").all();
  const retailerCol = info.find(c => c.name === 'retailer');
  if (!retailerCol || retailerCol.notnull === 0) return;
  console.log('Migrating contacts.retailer/department to nullable...');
  const cols = info.map(c => {
    let def = c.name + ' ' + c.type;
    if (c.name === 'id') def += ' PRIMARY KEY AUTOINCREMENT';
    if (c.dflt_value !== null) def += ' DEFAULT ' + c.dflt_value;
    return def;
  });
  const colNames = info.map(c => c.name).join(', ');
  db.transaction(() => {
    db.exec('CREATE TABLE contacts_new (' + cols.join(', ') + ')');
    db.exec('INSERT INTO contacts_new (' + colNames + ') SELECT ' + colNames + ' FROM contacts');
    db.exec('DROP TABLE contacts');
    db.exec('ALTER TABLE contacts_new RENAME TO contacts');
  })();
  console.log('contacts.retailer/department are now nullable');
}
ensureContactsRetailerDeptNullable();
ensureColumn('contacts', 'company', 'TEXT');
// Links a position='Factory' contact to its real factories row (see the
// factories table above) - supersedes the old free-text `company` column
// for matching purposes, though `company` is left in place unused (this
// app never drops columns) rather than migrated/cleared.
ensureColumn('contacts', 'factory_id', 'INTEGER');

// Free-text job title at the factory (e.g. "Merchandiser", "QC Manager",
// "Owner") - distinct from the fixed `position` enum above, which just
// categorizes this row as a Factory contact within the app, not what the
// person actually does there.
ensureColumn('contacts', 'job_title', 'TEXT');

// One-time backfill: any pre-existing position='Factory' contact (from
// before the factories table existed) gets a real factories row created
// from its old `company` name, or matched onto one that already shares that
// name, and linked via factory_id. Idempotent - only touches rows that
// still have no factory_id.
(function migrateFactoryContactsToFactoriesTable() {
  const orphans = db.prepare("SELECT * FROM contacts WHERE position = 'Factory' AND factory_id IS NULL").all();
  if (!orphans.length) return;
  const findFactory = db.prepare('SELECT id FROM factories WHERE name = ? COLLATE NOCASE');
  const insertFactory = db.prepare('INSERT INTO factories (name) VALUES (?)');
  const linkContact = db.prepare('UPDATE contacts SET factory_id = ? WHERE id = ?');
  orphans.forEach(c => {
    const name = (c.company || `${c.first_name} ${c.last_name}`).trim();
    let factory = findFactory.get(name);
    let factoryId = factory ? factory.id : insertFactory.run(name).lastInsertRowid;
    linkContact.run(factoryId, c.id);
  });
  console.log(`Migrated ${orphans.length} Factory contact(s) into the factories table`);
})();

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
ensureColumn('concepts', 'spec_category_id', 'INTEGER');
ensureColumn('concepts', 'size_range_id', 'INTEGER');
// Full field set for the single-drawer concept form - fabric_code/
// composition/weight mirror the fabrics lookup pattern already used on
// orders (routes/shipping.js), just added here too since concepts didn't
// have any fabric linkage before.
['fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
 'topstitching', 'trims', 'styling', 'units', 'packing', 'labels', 'dc_date', 'target', 'price']
  .forEach(col => ensureColumn('concepts', col, 'TEXT'));
// Costs tab - target/price above were superseded by these more specific
// fields and are no longer written to, left in place unused rather than
// dropped (this app never drops columns on an existing table).
['buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price']
  .forEach(col => ensureColumn('concepts', col, 'TEXT'));
ensureColumn('styles', 'concept_ref', 'TEXT');
ensureColumn('styles', 'cad_description', 'TEXT');
// Wash Care tab - the label image itself lives in the shared photos table
// as role='washcare' (same convention as role='cad'), this is just the
// free-text notes alongside it (e.g. care instructions not on the label,
// or a note about which label version is current).
ensureColumn('styles', 'washcare_details', 'TEXT');
// The leaf spec_categories node this style's measurement sheet was seeded
// from - see style_spec_poms/style_spec_fits above. Picking/changing this
// on the style (routes/styles.js's POST /:id/spec/select-category) is what
// actually copies the bank's POMs onto the style, this column alone is
// just which category that copy came from.
ensureColumn('styles', 'spec_category_id', 'INTEGER');
// Distinguishes a style's generated/uploaded CAD image from its ordinary
// reference photos - same convention as concept_photos.role.
ensureColumn('photos', 'role', "TEXT DEFAULT 'reference'");
// 200px-wide copy of `path`, generated at upload time (routes/styles.js) so
// the Style board can show every card's cover photo without pulling down a
// full-size image per card - same convention as concept_photos.thumb_path.
// Null for photos uploaded before this existed; attachCoverPhoto falls back
// to the full path for those.
ensureColumn('photos', 'thumb_path', 'TEXT');

// The Style drawer's Details tab now mirrors the Concept drawer's Details
// tab field-for-field (see public/js/drawer.js's renderBriefTab), so a
// style keeps every field a concept already captured instead of retyping a
// separate, thinner set - these are the fields styles didn't already have.
// fabric_code/composition/weight replace the old single free-text `fabric`
// column (left in place, just no longer edited); topstitching reuses the
// existing `topstitch` column rather than adding a near-duplicate.
['fabric_code', 'composition', 'weight', 'print', 'embroidery_applique',
 'packing', 'labels', 'source', 'tags', 'concept_date', 'shipping_date', 'dc_date']
  .forEach(col => ensureColumn('styles', col, 'TEXT'));
ensureColumn('styles', 'size_range_id', 'INTEGER');

// Style drawer's Cost tab (public/js/drawer.js's renderStyleCostsTab) mirrors
// the Concept drawer's own Costs tab field-for-field - same columns, same
// names, so CONCEPT_TO_STYLE_FIELDS can map them straight across on
// conversion with no renames. Replaces the old Worksheet tab's
// cost/margin/first_ship/first_delivery/shipment_note fields (left in place
// unused, not dropped) - % Margin itself is never stored, just recomputed
// from buyer_rand_target/buyer_rsp_target for display.
['cost_estimate', 'buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price']
  .forEach(col => ensureColumn('styles', col, 'TEXT'));

// Free-text record of the cheaper alternatives a factory counter-offers
// against a target price during costing - e.g. "can do $7.20 as briefed,
// or $7.00 without back pockets, or $6.80 with an enzyme wash instead of
// acid wash and no turn-up hem" - so that back-and-forth isn't lost outside
// email/WhatsApp. Lives on both concepts and styles' Cost tabs, same field
// name on both so CONCEPT_TO_STYLE_FIELDS maps it straight across.
ensureColumn('concepts', 'factory_cost_options', 'TEXT');
ensureColumn('styles', 'factory_cost_options', 'TEXT');

// Label for the concept's own (primary) fabric - only shown/used once a
// concept has extra fabric slots (see concept_fabrics above) for a
// multi-piece set, so the combined composition text can be built as
// "Dungaree: ... / T-Shirt: ..." rather than leaving the first piece
// unlabeled.
ensureColumn('concepts', 'fabric_prefix', 'TEXT');
ensureColumn('concept_fabrics', 'weight', 'TEXT');

// Each retailer specs a style differently, so the spec hierarchy (see
// spec_categories above) needs to be split per retailer too - a root
// category (and everything under it, since children inherit their root's
// retailer the same way they already inherit its department) now belongs
// to one retailer. Concepts still pick a spec category without knowing
// their retailer yet (that's only fixed once a concept becomes a style),
// so the Concepts drawer's own picker stays retailer-agnostic by design -
// only the Style drawer's picker and the Manage Spec Hierarchy admin
// screen actually filter by retailer. Existing categories (all created
// before this column existed) are backfilled onto 'PnP', the only
// retailer in use so far - see RETAILERS in public/js/board.js.
ensureColumn('spec_categories', 'retailer', 'TEXT');
db.prepare("UPDATE spec_categories SET retailer = 'PnP' WHERE retailer IS NULL").run();

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
// Rolls up an order's order_submission_docs rows into one status for the
// Shipping board/drawer to badge without re-checking all 8 slots itself -
// 'in_progress' (some slots filled), 'ready' (all 8 present, not sent yet)
// or 'sent' (emailed to the buyer). Empty string = nothing started yet.
// Recomputed server-side on every slot change (see routes/finalSubmission.js),
// not user-editable directly except the explicit "mark sent" action.
ensureColumn('orders', 'final_submission_status', "TEXT DEFAULT ''");
// The buyer's written worksheet confirming their verbal go-ahead on this
// order (see routes/shipping.js's worksheet upload routes) - deliberately
// separate from order_submission_docs/DOC_TYPES (routes/finalSubmission.js):
// a worksheet is an internal Elanzas record of order confirmation, not one
// of the documents that ever gets bundled/emailed to the buyer as part of
// bulk submission, so it doesn't belong in that checklist or its zip/email.
// Per-order rather than per-style since a repeat order needs its own
// worksheet, not the original run's.
ensureColumn('orders', 'worksheet_file_path', 'TEXT');
ensureColumn('orders', 'worksheet_original_filename', 'TEXT');
ensureColumn('orders', 'worksheet_uploaded_by', 'TEXT');
ensureColumn('orders', 'worksheet_uploaded_at', 'TEXT');
// Garment Manufacturer's country on the Material Submission form - fabric
// supplier/yarn supplier already have their own country_of_origin on
// fabrics (see db.js's fabrics migration comment), this is the third of
// that form's three country fields, factory-level rather than fabric-level.
ensureColumn('factories', 'country', 'TEXT');
// The code PnP assigns identifying who's importing/vending this factory's
// goods (e.g. "CU25179051" on the washcare label) - factory-level like
// country/registered_name, not per-style or per-order.
ensureColumn('factories', 'importer_vendor_code', 'TEXT');
// Article number as it appears on the actual PO (see lib/washcareLabelExport.js)
// - a style-level copy alongside orders.rms_article_no rather than looked
// up through one specific order, since a washcare label is generated per
// style, not per order, and the article number a style's own label should
// show doesn't need to track whichever order happens to be open.
ensureColumn('styles', 'art_no', 'TEXT');

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
// "Delete" for the Notification Centre - same per-user, same-key scheme as
// read_at above (see its comment: the key already bakes in the alert's
// current value, so a dismissed delay/renewal naturally reappears if it
// gets worse again - a fresh delay_count or approval_date is a different
// key). Alerts computed live from orders/fabrics have no row of their own
// to delete, so dismissal is the only "delete" that makes sense for those;
// fabric_report_flags rows (the one real stored alert type) are left in
// place too rather than actually deleted, so this stays one uniform
// mechanism for all three alert types instead of two different ones.
ensureColumn('notification_reads', 'dismissed_at', 'TEXT');

// Per-user section access (comma-separated: styles,concepts,shipping,
// contacts) - independent of role. Role still governs field-level scoping
// (buyers never see cost/margin, are locked to their own retailer+
// department) and edit rights (buyers can never create/edit/delete) -
// this only controls whether a section is visible/reachable at all.
ensureColumn('users', 'permissions', 'TEXT');
// A short numeric PIN (bcrypt-hashed, same as password_hash) a user can set
// under Settings so they can identify themselves to the "Elanza CRM" MCP
// connector over Claude Voice - voice can't complete the normal session
// login, so an action-attributing tool call (see routes/mcp.js's
// identify_user_by_pin and the pin param on add_comment/send_request/
// remind_request) verifies the PIN instead, so the resulting email/comment
// is attributed to the real person rather than a generic "Claude" sender.
// Optional - a blank pin_hash just means that user hasn't set one yet.
ensureColumn('users', 'pin_hash', 'TEXT');
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
// Same backfill for 'factories', added after both of the above.
db.prepare(`
  UPDATE users SET permissions = permissions || ',factories'
  WHERE role != 'buyer' AND permissions NOT LIKE '%factories%'
`).run();

ensureColumn('fabrics', 'weight', 'TEXT');
// Extra fields matching Pick n Pay's own "Material Submission form" (see
// public/PnPMaterialsubmissionV1.0 (003).pdf) - fabric-level properties
// only (type/construction/finishes/suppliers/yarn makeup). The form's other
// sections - Style Detail (department/season/style number/description) and
// half of Supplier Detail (Garment Manufacturer, sign-off date) - aren't
// fabric-level (a fabric can go into multiple styles/factories over time),
// so those aren't stored here; they'd come from the actual style/order at
// whatever future point this gets wired into a real "submit to buyer" flow.
['description', 'fabric_type', 'construction', 'construction_gauge', 'finishes',
 'fabric_supplier', 'yarn_supplier', 'country_of_origin']
  .forEach(col => ensureColumn('fabrics', col, 'TEXT'));
// Yarn Detail is a fixed 4-column grid on the form itself (Yarn 1-4, never
// more) - matching that shape directly with 4 sets of columns rather than a
// separate one-to-many table, since it's simplest and maps straight onto
// the form if this ever gets turned into a PDF auto-fill.
[1, 2, 3, 4].forEach(n => {
  ['type', 'composition', 'spinning', 'count', 'sustainability'].forEach(attr => {
    ensureColumn('fabrics', `yarn${n}_${attr}`, 'TEXT');
  });
});
// Fabrics used to also mirror the latest report's full field set
// (report_number, approval_date, valid_until, style_no, end_buyer,
// sample_description, overall_result, weight_gsm) - that's now tracked
// per-report on fabric_test_reports only, so drop the mirrored columns
// from any existing database that still has them.
['weight_gsm', 'report_number', 'approval_date', 'valid_until', 'style_no', 'end_buyer', 'sample_description',
 'overall_result', 'testing_period_start', 'testing_period_end']
  .forEach(col => dropColumnIfExists('fabrics', col));
ensureColumn('fabric_test_reports', 'weight_oz', 'TEXT');
// Distinguishes the base/bulk fabric test (always required) from the
// additional print/embellishment durability test (required in addition
// whenever a concept has Print or Embroidery/Applique details) - see
// public/js/concepts.js's fabric-report-requirement banner.
ensureColumn('fabric_test_reports', 'report_type', "TEXT DEFAULT 'base'");
// Tracks whether a factory has replied on a sent request yet - see
// routes/requests.js's PUT :id/status and the Requests nav section's
// Awaiting/Received filter. received_at is set the moment status flips to
// 'received' (and cleared if flipped back), so it doubles as "when did the
// reply come back" without a separate column. request_type/message/
// reminder_count/last_reminder_at only need ensureColumn for databases that
// had this table before it grew past cost-only requests - the CREATE TABLE
// above already includes them for a fresh install.
ensureColumn('concept_requests', 'status', "TEXT DEFAULT 'awaiting'");
ensureColumn('concept_requests', 'received_at', 'TEXT');
ensureColumn('concept_requests', 'request_type', "TEXT DEFAULT 'cost'");
ensureColumn('concept_requests', 'message', 'TEXT');
ensureColumn('concept_requests', 'reminder_count', 'INTEGER DEFAULT 0');
ensureColumn('concept_requests', 'last_reminder_at', 'TEXT');
// A request can now be sent from a Style's own Requests tab too (a sample,
// PP sample, bulk sample, or fabric test request against a confirmed style
// rather than a still-in-development concept - see routes/styles.js's
// send-request route). Every row still has exactly one of concept_id/
// style_id set, never both - see ensureConceptRequestsConceptIdNullable
// below for why concept_id had to stop being NOT NULL to allow this.
ensureColumn('concept_requests', 'style_id', 'INTEGER');
ensureColumn('concept_requests', 'style_no', 'TEXT');
ensureColumn('concept_requests', 'style_description', 'TEXT');
// SQLite can't drop a NOT NULL constraint in place - same table-rebuild
// technique as ensureOrdersStyleIdNullable/ensureContactsRetailerDeptNullable
// above, idempotent via PRAGMA table_info.
function ensureConceptRequestsConceptIdNullable() {
  const info = db.prepare("PRAGMA table_info(concept_requests)").all();
  const conceptIdCol = info.find(c => c.name === 'concept_id');
  if (!conceptIdCol || conceptIdCol.notnull === 0) return;
  console.log('Migrating concept_requests.concept_id to nullable...');
  const cols = info.map(c => {
    let def = c.name + ' ' + c.type;
    if (c.name === 'id') def += ' PRIMARY KEY AUTOINCREMENT';
    if (c.name === 'concept_id') def += ' REFERENCES concepts(id)';
    if (c.name === 'style_id') def += ' REFERENCES styles(id)';
    if (c.dflt_value !== null) def += ' DEFAULT ' + c.dflt_value;
    return def;
  });
  const colNames = info.map(c => c.name).join(', ');
  db.exec('PRAGMA foreign_keys=OFF;');
  db.transaction(() => {
    db.exec('CREATE TABLE concept_requests_new (' + cols.join(', ') + ')');
    db.exec('INSERT INTO concept_requests_new (' + colNames + ') SELECT ' + colNames + ' FROM concept_requests');
    db.exec('DROP TABLE concept_requests');
    db.exec('ALTER TABLE concept_requests_new RENAME TO concept_requests');
  })();
  db.exec('PRAGMA foreign_keys=ON;');
  console.log('concept_requests.concept_id is now nullable');
}
ensureConceptRequestsConceptIdNullable();

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
    insertUser.run('Abbey Kilian', 'abbey@pnp.co.za', bcrypt.hashSync('H*yF!bN!j4f#XC', 10), 'buyer', 'PnP', 'Ladies');
    console.log('Seeded users');
  }

  // One-time correction: an earlier version of the seed above used the full
  // retailer name 'Pick n Pay' instead of the short code every other part of
  // the app actually scopes by (see RETAILERS in public/js/board.js) -
  // styles.retailer, contacts.retailer, and now spec_categories.retailer are
  // all 'PnP'/'Eagle'/'PEP', so a buyer stuck on the old full name would
  // never match any of their own retailer's styles or spec categories.
  db.prepare("UPDATE users SET retailer = 'PnP' WHERE retailer = 'Pick n Pay'").run();

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

  // No longer auto-seeds a demo style when the table is empty - that was
  // fine for a brand-new dev install, but this app is in real production
  // use now, and an empty styles table is a legitimate, intentional state
  // (see scripts/reset-concepts-and-styles.js / the Settings > Danger Zone
  // reset action) that shouldn't get a surprise demo row injected back in.
}

seed();

module.exports = { db, BUYER_VISIBLE_STYLE_FIELDS };
