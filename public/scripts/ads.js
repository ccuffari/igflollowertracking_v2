/* scripts/ads.js
   Robust ad slot helper.
   - evita doppie chiamate adsbygoogle.push()
   - usa lock per race conditions
   - salta slot già renderizzati (controlla data-adsbygoogle-status)
   - disabilita slot troppo stretti
*/

(function () {
  const CLIENT = 'ca-pub-1948802026580753';
  const DEFAULT_MIN_WIDTH = 300;
  const ATTR_CREATED = 'data-ad-created';
  const ATTR_CREATING = 'data-ad-creating';

  function getMinWidth(container) {
    const attr = container.getAttribute('data-min-width');
    return attr ? parseInt(attr, 10) : DEFAULT_MIN_WIDTH;
  }

  // verifica se un <ins> è già stato effettivamente popolato da AdSense
  function insIsDone(ins) {
    try {
      const s = ins.getAttribute('data-adsbygoogle-status');
      if (s && s.toLowerCase() === 'done') return true;
    } catch (e) { /* ignore */ }
    if (ins.getAttribute && ins.getAttribute(ATTR_CREATED) === '1') return true;
    return false;
  }

  // rimuove ins non valide o vuote
  function cleanupInner(inner) {
    const all = Array.from(inner.querySelectorAll('ins.adsbygoogle'));
    for (const i of all) {
      // se l'ins esiste ma è incompleto e non in stato creating lo rimuoviamo
      if (!insIsDone(i) && !i.getAttribute(ATTR_CREATING)) {
        try { i.remove(); } catch (e) { /* ignore */ }
      }
    }
  }

  function createInsElement(slot) {
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', CLIENT);
    if (slot) ins.setAttribute('data-ad-slot', slot);
    ins.setAttribute('data-ad-format', 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');
    return ins;
  }

  // safe push with lock and cleanup on error
  function safePush(container, ins) {
    // lock container to avoid concurrent creation
    container.setAttribute(ATTR_CREATING, '1');
    // mark ins as creating to distinguish from leftover elements
    ins.setAttribute(ATTR_CREATING, '1');

    try {
      // If adsbygoogle is not available yet, push will throw; handle gracefully.
      (adsbygoogle = window.adsbygoogle || []).push({});
      // push returned without throwing. mark as created.
      ins.setAttribute(ATTR_CREATED, '1');
    } catch (err) {
      // remove the ins we appended to avoid stale elements that cause future errors
      try { ins.remove(); } catch (e) { /* ignore */ }
      console.warn('AdSense push failed (safePush):', err);
    } finally {
      // cleanup creating flags
      container.removeAttribute(ATTR_CREATING);
      try { ins.removeAttribute(ATTR_CREATING); } catch (e) { /* ignore */ }
    }
  }

  function createAdSlot(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const inner = container.querySelector('.ad-inner');
    if (!inner) return;

    const slot = container.getAttribute('data-slot');
    const minWidth = getMinWidth(container);

    // misura disponibile
    const available = Math.floor(inner.getBoundingClientRect().width);

    // se troppo piccolo, rimuovi eventuali ins vuoti e nascondi
    if (available < minWidth) {
      // rimuovi solo gli ins incompleti per evitare errore "already have ads"
      cleanupInner(inner);
      container.classList.remove('ad-enabled');
      container.classList.add('ad-placeholder');
      container.removeAttribute(ATTR_CREATED);
      return;
    }

    // se container è in stato creating evita ri-entrata
    if (container.getAttribute(ATTR_CREATING) === '1') {
      return;
    }

    // se già creato, segna enabled e esci
    if (container.getAttribute(ATTR_CREATED) === '1') {
      container.classList.add('ad-enabled');
      container.classList.remove('ad-placeholder');
      return;
    }

    // se esiste un ins già "done", segna creato e esci
    const existingDone = inner.querySelector('ins.adsbygoogle[data-adsbygoogle-status="done"], ins.adsbygoogle[' + ATTR_CREATED + '="1"]');
    if (existingDone) {
      container.setAttribute(ATTR_CREATED, '1');
      container.classList.add('ad-enabled');
      container.classList.remove('ad-placeholder');
      return;
    }

    // pulisci ins orfani prima di crearne uno nuovo
    cleanupInner(inner);

    // crea ins e append
    const ins = createInsElement(slot);
    inner.appendChild(ins);

    // piccolo guard finale: se ora l'ins risulta già done (edge case) -> set flags e skip push
    if (insIsDone(ins)) {
      container.setAttribute(ATTR_CREATED, '1');
      container.classList.add('ad-enabled');
      container.classList.remove('ad-placeholder');
      try { ins.removeAttribute(ATTR_CREATING); } catch (e) {}
      return;
    }

    // se il browser non ha ancora caricato il client di Google, safePush lo gestirà
    safePush(container, ins);

    // dopo push, se l'ins è segnato come done o abbiamo segnato created, abilitiamo il container
    if (insIsDone(ins) || container.getAttribute(ATTR_CREATED) === '1') {
      container.classList.remove('ad-placeholder');
      container.classList.add('ad-enabled');
    } else {
      // se push ha fallito o non ha segnato lo stato, lasciamo l'ins rimosso (safePush già lo fa)
      container.classList.remove('ad-enabled');
      container.classList.add('ad-placeholder');
      container.removeAttribute(ATTR_CREATED);
    }
  }

  function observeAdContainers() {
    const containers = Array.from(document.querySelectorAll('.ad-container'));
    if (!containers.length) return;

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const container = entry.target;
        try { createAdSlot(container.id); } catch (e) { console.warn('createAdSlot error', e); }
      }
    });

    containers.forEach(c => {
      // inizializza con delay per lasciare layout stabilizzarsi
      setTimeout(() => createAdSlot(c.id), 120);
      try { ro.observe(c); } catch (e) { /* ignore for old browsers */ }
    });

    window.addEventListener('resize', () => {
      containers.forEach(c => {
        try { createAdSlot(c.id); } catch (e) {}
      });
    }, { passive: true });
  }

  // Public init
  window.__adsHelperInit = function () {
    // se la pagina è in quirks, non inizializzare gli ads
    if (window.__PAGE_IN_QUIRKS) {
      console.warn('Skipping ads init: page in Quirks Mode.');
      return;
    }
    observeAdContainers();
  };

  // Init auto on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.__adsHelperInit);
  } else {
    window.__adsHelperInit();
  }
})();
