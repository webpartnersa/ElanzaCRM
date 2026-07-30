// No offline support by design - this app always needs a connection to
// upload photos. Registered only so Chrome/PWABuilder count the page as an
// installable PWA (a fetch handler is part of that criteria); every request
// just passes straight through to the network.
self.addEventListener('fetch', () => {});
