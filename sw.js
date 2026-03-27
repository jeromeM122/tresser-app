/**
 * ============================================================
 *  TRESSER — Service Worker v1.0
 *  Stratégie : Stale-While-Revalidate (SWR)
 * ============================================================
 *
 *  COMMENT ÇA MARCHE — pour une cliente Tresser sur 4G faible :
 *
 *  1ère visite (cache vide) :
 *    Browser → Réseau → Réponse affichée + sauvegardée en cache.
 *    La cliente attend normalement le réseau (ex: 2–4 secondes).
 *
 *  2ème visite et suivantes (cache chaud) :
 *    Browser → Cache local (instantané, < 50ms) → Page affichée.
 *    EN PARALLÈLE, en arrière-plan, le SW contacte le réseau pour
 *    vérifier s'il y a une version plus récente. Si oui, il met à
 *    jour le cache silencieusement pour la PROCHAINE visite.
 *
 *  Résultat : l'utilisatrice voit la page quasi-instantanément,
 *  même avec 1 barre de réseau. La fraîcheur du contenu est
 *  maintenue sans jamais bloquer l'affichage.
 *
 *  Comparaison des stratégies (pourquoi SWR est le bon choix ici) :
 *  ┌─────────────────────────┬──────────┬──────────┬───────────┐
 *  │ Stratégie               │ Vitesse  │ Fraîcheur│ Offline   │
 *  ├─────────────────────────┼──────────┼──────────┼───────────┤
 *  │ Network Only            │   ❌     │   ✅     │    ❌     │
 *  │ Cache Only              │   ✅     │   ❌     │    ✅     │
 *  │ Cache First             │   ✅     │   ⚠️     │    ✅     │
 *  │ Network First           │   ⚠️     │   ✅     │    ⚠️     │
 *  │ Stale-While-Revalidate  │   ✅     │   ✅     │    ✅     │  ← Tresser
 *  └─────────────────────────┴──────────┴──────────┴───────────┘
 * ============================================================
 */

/* ----------------------------------------------------------
   1. CONFIGURATION
---------------------------------------------------------- */

/** Nom du cache — incrémenter la version force un nouveau cache */
const CACHE_NAME = 'tresser-v1.0.0';

/**
 * Assets critiques à pré-cacher lors de l'installation.
 * Ces fichiers seront disponibles immédiatement dès la 1ère visite.
 * Garder cette liste COURTE : chaque entrée est téléchargée à l'install.
 */
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

/**
 * Assets à mettre en cache dynamiquement (à la demande).
 * Ces patterns correspondent aux ressources récupérées lors de la navigation.
 */
const DYNAMIC_CACHE_PATTERNS = [
  /\.(?:css|js)$/,           // Feuilles de style et scripts
  /\.(?:woff2?|ttf|otf)$/,   // Polices (Playfair Display, DM Sans)
  /\.(?:png|jpg|jpeg|webp|svg|avif)$/,  // Images produits et routines
  /^https:\/\/fonts\.googleapis\.com/,  // Google Fonts CSS
  /^https:\/\/fonts\.gstatic\.com/,     // Google Fonts fichiers
];

/** Durée maximale de vie d'une entrée en cache (en secondes) */
const CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 jours

/** Nombre max d'entrées dans le cache dynamique (évite de saturer le stockage) */
const DYNAMIC_CACHE_MAX_ENTRIES = 60;


/* ----------------------------------------------------------
   2. INSTALLATION — Pré-cache des assets critiques
---------------------------------------------------------- */

self.addEventListener('install', (event) => {
  console.log('[Tresser SW] Installation — pré-cache des assets critiques');

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        /**
         * addAll() est atomique : si UN seul asset échoue,
         * tout le pré-cache est annulé. Mettre ici UNIQUEMENT
         * les fichiers dont on est sûr de l'existence en prod.
         */
        await cache.addAll(PRECACHE_ASSETS);
        console.log('[Tresser SW] Assets critiques mis en cache avec succès');
      } catch (err) {
        console.error('[Tresser SW] Échec du pré-cache :', err);
      }
    })
  );

  /**
   * skipWaiting() : active ce SW immédiatement sans attendre
   * la fermeture de tous les onglets existants.
   * Idéal pour les PWA où la mise à jour doit être immédiate.
   */
  self.skipWaiting();
});


/* ----------------------------------------------------------
   3. ACTIVATION — Nettoyage des anciens caches
---------------------------------------------------------- */

self.addEventListener('activate', (event) => {
  console.log('[Tresser SW] Activation — nettoyage des anciens caches');

  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((oldCache) => {
            console.log('[Tresser SW] Suppression ancien cache :', oldCache);
            return caches.delete(oldCache);
          })
      );

      /**
       * clients.claim() : prend le contrôle de tous les onglets
       * ouverts immédiatement, sans attendre leur rechargement.
       */
      await self.clients.claim();
      console.log('[Tresser SW] SW actif et en contrôle de tous les clients');
    })()
  );
});


/* ----------------------------------------------------------
   4. FETCH — Stratégie Stale-While-Revalidate
---------------------------------------------------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignorer les requêtes non-GET (POST pour analytics, etc.) */
  if (request.method !== 'GET') return;

  /* Ignorer les extensions Chrome internes */
  if (url.protocol === 'chrome-extension:') return;

  /* Ignorer les requêtes vers des domaines tiers non listés */
  const isDynamic = DYNAMIC_CACHE_PATTERNS.some((pattern) => pattern.test(request.url));
  const isNavigation = request.mode === 'navigate';

  if (!isNavigation && !isDynamic) return;

  /* ---- Appliquer Stale-While-Revalidate ---- */
  event.respondWith(staleWhileRevalidate(request));
});


/**
 * staleWhileRevalidate(request)
 *
 * Logique en 3 temps :
 *  A. Chercher en cache → répondre immédiatement si trouvé (stale)
 *  B. EN PARALLÈLE → aller chercher sur le réseau (revalidate)
 *  C. Mettre à jour le cache avec la réponse réseau fraîche
 *
 * Si le cache est vide → attendre le réseau (1ère visite normale).
 * Si le réseau échoue → utiliser le cache (offline/4G faible).
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);

  /**
   * On lance la requête réseau EN PARALLÈLE — pas en série.
   * C'est le cœur de SWR : ne jamais bloquer l'affichage sur le réseau.
   */
  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      /* Valider la réponse avant de la mettre en cache */
      if (isValidResponse(networkResponse)) {
        const responseToCache = networkResponse.clone();

        await cache.put(request, responseToCache);
        await trimCache(cache, DYNAMIC_CACHE_MAX_ENTRIES);

        console.log('[Tresser SW] Cache mis à jour :', request.url);
      }
      return networkResponse;
    })
    .catch((err) => {
      console.warn('[Tresser SW] Réseau indisponible pour :', request.url, err.message);
      /* Retourner undefined pour que le fallback cache prenne le relais */
      return undefined;
    });

  if (cachedResponse) {
    /**
     * Cache HIT : on répond immédiatement avec la version en cache
     * (même si elle a quelques heures). La requête réseau continue
     * en arrière-plan pour rafraîchir le cache silencieusement.
     */
    console.log('[Tresser SW] Réponse depuis le cache (stale) :', request.url);
    return cachedResponse;
  }

  /**
   * Cache MISS (1ère visite) : on attend le réseau.
   * Si le réseau échoue aussi → page offline de fallback.
   */
  console.log('[Tresser SW] Cache vide, attente réseau :', request.url);
  const networkResponse = await networkPromise;

  if (networkResponse) return networkResponse;

  /* Dernier recours : page offline si navigation */
  if (request.mode === 'navigate') {
    const offlinePage = await cache.match('/index.html');
    if (offlinePage) return offlinePage;
  }

  /* Réponse d'erreur générique */
  return new Response('Contenu indisponible hors ligne.', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}


/* ----------------------------------------------------------
   5. UTILITAIRES
---------------------------------------------------------- */

/**
 * Vérifie qu'une réponse réseau est valide et mérite d'être cachée.
 * On rejette les erreurs serveur (5xx) et les réponses opaques douteuses.
 */
function isValidResponse(response) {
  if (!response) return false;

  /* Réponse opaque (cross-origin sans CORS) : on cache quand même
     car on ne peut pas lire le status, mais c'est acceptable pour les fonts */
  if (response.type === 'opaque') return true;

  return response.ok; /* status 200–299 */
}


/**
 * Limite le nombre d'entrées dans le cache pour éviter de saturer
 * le stockage du téléphone. Supprime les plus anciennes en premier (FIFO).
 */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();

  if (keys.length > maxEntries) {
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
    console.log(`[Tresser SW] Cache nettoyé : ${toDelete.length} entrée(s) supprimée(s)`);
  }
}


/* ----------------------------------------------------------
   6. MESSAGES — Communication SW ↔ Page
---------------------------------------------------------- */

/**
 * Canal de communication pour forcer des actions depuis la page.
 * Exemple d'usage dans index.html :
 *
 *   navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[Tresser SW] SKIP_WAITING reçu — mise à jour forcée');
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('[Tresser SW] Cache vidé sur demande');
    });
  }
});
