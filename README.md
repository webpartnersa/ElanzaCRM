# Docket Portal — modular structure

Each section of the app lives in its own file. To change something, you
only need to touch the one file for that section:

## Backend
| To change...                          | Edit this file          |
|----------------------------------------|--------------------------|
| Login, logout, change-my-password       | routes/auth.js           |
| The styles/pipeline section (list, detail, comments, photo upload) | routes/styles.js |
| The admin users section (create/edit/delete users) | routes/users.js  |
| Who's allowed to do what (auth rules)   | middleware/auth.js       |
| What fields a buyer can see             | lib/scope.js             |
| Database structure / seed data          | db.js                    |
| Overall app wiring (rarely needs touching) | server.js              |

## Frontend
| To change...                          | Edit this file              |
|----------------------------------------|-------------------------------|
| The login screen                        | public/js/login.js            |
| The sidebar / page shell                | public/js/shell.js            |
| The pipeline board (columns, cards, + New Style, thumbnails) | public/js/board.js |
| The style drawer (tabs, save, photo, discussion doc) | public/js/drawer.js  |
| The admin users screen                  | public/js/users.js            |
| Popup dialogs (change password, etc.)   | public/js/modals.js           |
| Colours, fonts, spacing, layout         | public/style.css              |
| Page routing / what loads first         | public/js/app.js              |

## Deploying this update

1. Unzip this file anywhere on your computer.
2. In FileZilla, connect to the server as usual and navigate to
   `/home/docket/docket-portal` on the server side.
3. On your **local** side (left panel), navigate into the unzipped folder.
4. Select everything inside it and drag it into the server-side panel (or
   right-click → Upload). When FileZilla asks about overwriting, choose
   **Overwrite** (or "overwrite all" to avoid being asked repeatedly).
5. **Delete two old files FileZilla will leave behind**, since it only
   overwrites/adds, never removes: in `public/js/`, delete `dashboard.js`
   and `detail.js` if present — replaced by `board.js` and `drawer.js`.
   Harmless if left, just untidy (`index.html` no longer loads them).
6. This update adds a new dependency (`multer`, for photo uploads) — over
   SSH:
   ```
   cd ~/docket-portal
   npm install
   ```
7. Restart the app so the backend changes take effect:
   ```
   pm2 restart docket-portal
   ```
8. Hard-refresh the site (Ctrl+F5) and test: log in, open a style, add
   several photos at once, click one to enlarge (and click outside or the
   X to close), remove one, check the board card thumbnail shows the
   first photo, move a style between stages, fill in a Tech Spec field
   and Save, check the Discussion Doc tab reflects it, and confirm
   Abbey's buyer login still can't see cost/margin/factory but *can* see
   photos.

## What did NOT change

Your database (`docket-portal.db`) and existing users/styles/comments are
untouched. New columns (photo path, tech-spec fields) are added to
existing rows automatically and safely on first startup — nothing is
deleted or overwritten.

## Going forward

For a small tweak to one section — say, adding a field to the users list —
edit `routes/users.js` (data/API change) and/or `public/js/users.js`
(display change), re-upload just that file, and restart PM2 only if a
**backend** file changed. Frontend-only changes (`public/`) never need a
PM2 restart — just a browser refresh.
