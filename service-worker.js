const CACHE_NAME = 'hand-globe-cache-v2';
const urlsToCache = [
  // It's often better to explicitly list index.html than rely solely on '/'
  '/', // Keep this for the root request
  'index.html',        
  'style.css',        
  'app.js',           
  'manifest.json',    
  'icons/icon-512x512.png' 

];

self.addEventListener('activate', event => {
  console.log('[Service Worker] Activate');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) { 
            console.log('[Service Worker] Removing old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});