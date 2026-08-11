const sharp = require('sharp');

// Renders a woven/printed-style wash care label as a PNG, matching the
// layout of public/final-submission/pl036b-washcare.png (the real label
// example this was built from): style no, composition, a fixed row of 5
// ISO 3758/GINETEX-style care icons, the free-text care instructions
// (styles.washcare_details), country of manufacture, importer/vendor code
// and article number, and season. The icon set is fixed (cold wash, medium
// iron, no tumble dry, no dry clean, no bleach) rather than chosen per
// style - see the icon-approach discussion this was built against; revisit
// if per-style icon selection is ever needed.
//
// Built as one SVG string rasterized by sharp, rather than compositing
// separate icon image assets - keeps this a single pure-data-in/PNG-out
// function with no asset files to ship alongside it.

const W = 300, H = 620;

function escapeXml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Each icon is drawn in its own 32x32 box at (x,y).
const ICON = {
  wash: (x, y) => `
    <g transform="translate(${x},${y})" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round">
      <path d="M4 3 H28 L25 29 H7 Z"/>
      <path d="M6 9 Q10 6.5 14 9 T22 9 T26.5 9" stroke-width="1.2"/>
      <text x="16" y="20" font-size="7" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#000" stroke="none">30°C</text>
    </g>`,
  iron: (x, y) => `
    <g transform="translate(${x},${y})" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round">
      <path d="M2 12 Q2 5 11 5 H23 Q29 5 29 11 V17 Q29 23 21 23 H8 Q2 23 2 17 Z"/>
      <circle cx="13" cy="27" r="1.3" fill="#000" stroke="none"/>
      <circle cx="18" cy="27" r="1.3" fill="#000" stroke="none"/>
    </g>`,
  noTumbleDry: (x, y) => `
    <g transform="translate(${x},${y})" fill="none" stroke="#000" stroke-width="1.5">
      <rect x="2" y="2" width="28" height="28"/>
      <circle cx="16" cy="16" r="9"/>
      <circle cx="16" cy="16" r="1.4" fill="#000" stroke="none"/>
      <line x1="1" y1="1" x2="31" y2="31" stroke-width="1.8"/>
    </g>`,
  noDryClean: (x, y) => `
    <g transform="translate(${x},${y})" fill="none" stroke="#000" stroke-width="1.5">
      <circle cx="16" cy="16" r="13"/>
      <line x1="4" y1="4" x2="28" y2="28" stroke-width="1.8"/>
    </g>`,
  noBleach: (x, y) => `
    <g transform="translate(${x},${y})" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round">
      <path d="M16 2 L30 29 H2 Z"/>
      <line x1="4" y1="6" x2="28" y2="27" stroke-width="1.8"/>
    </g>`,
};

function wrapLines(text, maxCharsPerLine) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach(w => {
    if ((current + ' ' + w).trim().length > maxCharsPerLine && current) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  });
  if (current) lines.push(current);
  return lines;
}

async function buildWashcareLabelPng({ style, fabric, factory }) {
  const composition = (style && style.composition) || (fabric && fabric.composition) || '';
  const compLines = wrapLines(composition, 30);
  const careLines = ((style && style.washcare_details) || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let y = 30;
  const parts = [];
  parts.push(`<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="#fff" stroke="#000" stroke-width="1.5"/>`);

  parts.push(`<text x="${W / 2}" y="${y}" font-size="20" font-weight="bold" font-family="Arial,Helvetica,sans-serif" text-anchor="middle">${escapeXml((style && style.style_no) || '')}</text>`);
  y += 30;

  compLines.forEach(line => {
    parts.push(`<text x="${W / 2}" y="${y}" font-size="11" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#333">${escapeXml(line)}</text>`);
    y += 16;
  });
  y += 14;

  const icons = ['wash', 'iron', 'noTumbleDry', 'noDryClean', 'noBleach'];
  const iconGap = 48;
  const iconsStartX = (W - (icons.length - 1) * iconGap - 32) / 2;
  icons.forEach((key, i) => parts.push(ICON[key](iconsStartX + i * iconGap, y)));
  y += 48;

  careLines.forEach(line => {
    parts.push(`<text x="${W / 2}" y="${y}" font-size="10" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#222">${escapeXml(line)}</text>`);
    y += 15;
  });
  y += 16;

  parts.push(`<line x1="20" y1="${y - 8}" x2="${W - 20}" y2="${y - 8}" stroke="#ccc" stroke-width="1"/>`);

  const footerLines = [
    factory && factory.country ? `Made in ${factory.country}` : null,
    factory && factory.importer_vendor_code ? `Importer/Vendor code: ${factory.importer_vendor_code}` : null,
    style && style.art_no ? `Art. No: ${style.art_no}` : null,
    style && style.season ? `Season: ${style.season}` : null,
  ].filter(Boolean);
  footerLines.forEach(line => {
    parts.push(`<text x="${W / 2}" y="${y}" font-size="10" font-family="Arial,Helvetica,sans-serif" text-anchor="middle" fill="#000">${escapeXml(line)}</text>`);
    y += 16;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { buildWashcareLabelPng };
