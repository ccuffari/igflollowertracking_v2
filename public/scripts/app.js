document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50,
    ITEMS_PER_PAGE: 100
  };

  // ========== STATO DELL'APPLICAZIONE ==========
  let isProcessing = false;
  let currentNotFollowingBack = [];
  let currentFollowingCount = 0;
  let currentFollowersCount = 0;
  let currentPage = 1;
  let currentRemovedDeactivatedCount = 0;  // profili esclusi perché marcati come disattivati
  let currentSaveNote = null;              // { text, kind } nota di salvataggio dell'analisi
  let analysisSeq = 0;                     // evita di aggiornare la UI con esiti di analisi precedenti
  let skipStoreRerender = false;           // evita il re-render completo durante il toggle "Disattivato"

  function storeStatus() {
    return window.IGFTStore ? window.IGFTStore.getStatus() : { autoSave: false };
  }

  function notifyUser(message, kind) {
    if (window.IGFTUI && window.IGFTUI.toast) {
      window.IGFTUI.toast(message, kind);
    }
  }

  // ========== FUNZIONI DI ESTRAZIONE (invariate) ==========
  function cleanInstagramUsername(username) {
    if (window.IGFTCore) return window.IGFTCore.normalizeUsername(username);
    if (!username || typeof username !== 'string') return null;
    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) return null;
    if (!/^[a-z0-9._]+$/.test(cleanUsername)) return null;
    return cleanUsername;
  }

  function extractFollowersUsernames(jsonData) {
    const usernames = new Set();
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.string_list_data && Array.isArray(item.string_list_data)) {
            item.string_list_data.forEach(stringItem => {
              if (stringItem.value && stringItem.value.trim() !== "") {
                const username = cleanInstagramUsername(stringItem.value);
                if (username) usernames.add(username);
              }
            });
          }
        });
      }
    } catch (error) {
      console.error('Errore analisi followers JSON:', error);
    }
    return Array.from(usernames);
  }

  function extractFollowingUsernames(jsonData) {
    const usernames = new Set();
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      if (data.relationships_following && Array.isArray(data.relationships_following)) {
        data.relationships_following.forEach(item => {
          if (item.title && item.title.trim() !== "") {
            const username = cleanInstagramUsername(item.title);
            if (username) usernames.add(username);
          }
        });
      }
    } catch (error) {
      console.error('Errore analisi following JSON:', error);
    }
    return Array.from(usernames);
  }

  // ========== CARICAMENTO JSZIP (invariato) ==========
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => {
        const fallbackScript = document.createElement('script');
        fallbackScript.src = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
        fallbackScript.onload = () => resolve(window.JSZip);
        fallbackScript.onerror = () => reject(new Error('Impossibile caricare JSZip'));
        document.head.appendChild(fallbackScript);
      };
      document.head.appendChild(script);
    });
  }

  // ========== SALVATAGGIO ANALISI (storico) ==========
  async function saveAnalysisInBackground(seq, report) {
    const Store = window.IGFTStore;
    if (!Store || !storeStatus().autoSave) return;

    try {
      const saved = await Store.saveAnalysis(report);
      if (seq !== analysisSeq) return;

      if (!saved) {
        currentSaveNote = { text: 'Salvataggio dell\'analisi non riuscito.', kind: 'error', showHistory: true };
      } else {
        currentSaveNote = {
          text: saved.storage === 'cloud'
            ? 'Analisi salvata su Firestore.'
            : 'Analisi in coda: verrà sincronizzata su Firestore appena possibile.',
          kind: 'success',
          showHistory: true
        };
      }
    } catch (error) {
      if (seq !== analysisSeq) return;
      currentSaveNote = {
        text: 'Salvataggio dell\'analisi non riuscito: ' + (error.message || 'errore sconosciuto'),
        kind: 'error',
        showHistory: true
      };
    }

    if (seq === analysisSeq) displayResults(currentPage);
  }

  // ========== GESTIONE ZIP (modificata per non fare verifica automatica) ==========
  async function processZipFile(file) {
    if (isProcessing) return;
    
    const results = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');
    const zipInput = document.getElementById('zipfile');
    
    if (zipInput) zipInput.disabled = true;
    isProcessing = true;

    statusPill.textContent = '🔄 Analisi...';
    statusPill.className = 'pill processing';
    results.innerHTML = `
      <div class="res-empty">
        <div class="res-empty__icon" aria-hidden="true">📁</div>
        <h3>Caricamento file...</h3>
        <p>Analisi del file ZIP in corso. Potrebbe richiedere qualche secondo.</p>
      </div>
    `;
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      
      let followingFile = null;
      const followerFiles = [];
      
      zip.forEach((path, entry) => {
        if (!entry.dir) {
          const lowerPath = path.toLowerCase();
          if (lowerPath.endsWith('following.json')) followingFile = entry;
          if (lowerPath.includes('followers') && lowerPath.endsWith('.json')) followerFiles.push(entry);
        }
      });
      
      if (!followingFile) throw new Error('File "following.json" non trovato');
      if (followerFiles.length === 0) throw new Error('Nessun file "followers" trovato');
      
      results.innerHTML = `
        <div class="res-empty">
          <div class="res-empty__icon" aria-hidden="true">🔍</div>
          <h3>Analisi dati...</h3>
          <p>Estrazione delle informazioni dagli account.</p>
        </div>
      `;
      
      const followingContent = await followingFile.async('string');
      const followingUsernames = extractFollowingUsernames(followingContent);
      
      const allFollowers = new Set();
      for (const followerFile of followerFiles) {
        const followerContent = await followerFile.async('string');
        const followerUsernames = extractFollowersUsernames(followerContent);
        followerUsernames.forEach(u => allFollowers.add(u));
      }
      
      const followersArray = Array.from(allFollowers);
      const followersSet = new Set(followersArray);
      let notFollowingBack = followingUsernames.filter(u => !followersSet.has(u));

      // Applica la memoria dei profili disattivati (locale o Firestore).
      let removedDeactivated = [];
      if (window.IGFTStore) {
        try {
          await window.IGFTStore.ready;
          const filterResult = window.IGFTCore.filterDeactivated(
            notFollowingBack,
            window.IGFTStore.getDeactivatedUsernames()
          );
          notFollowingBack = filterResult.kept;
          removedDeactivated = filterResult.removed;
        } catch (error) {
          console.warn('Filtro profili disattivati non disponibile:', error);
        }
      }

      // NON eseguiamo verifica automatica, lasciamo all'utente la scelta
      const seq = ++analysisSeq;
      currentNotFollowingBack = notFollowingBack;
      currentFollowingCount = followingUsernames.length;
      currentFollowersCount = followersArray.length;
      currentRemovedDeactivatedCount = removedDeactivated.length;
      currentPage = 1;
      currentSaveNote = null;
      
      // Mostra risultati con pagina 1 (senza verifica)
      displayResults(1);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';

      saveAnalysisInBackground(seq, {
        followingCount: currentFollowingCount,
        followersCount: currentFollowersCount,
        notFollowing: currentNotFollowingBack.slice(),
        removedDeactivatedCount: currentRemovedDeactivatedCount
      });
      
    } catch (error) {
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div class="res-empty">
          <div class="res-empty__icon" aria-hidden="true">⚠️</div>
          <h3>Si è verificato un errore</h3>
          <p>${error.message || 'Errore durante l\'analisi del file. Assicurati di aver caricato lo ZIP corretto scaricato da Instagram.'}</p>
        </div>
      `;
    } finally {
      if (zipInput) zipInput.disabled = false;
      isProcessing = false;
    }
  }

  // ========== VISUALIZZAZIONE RISULTATI CON PAGINAZIONE E PULSANTE VERIFICA ==========
  function displayResults(page = 1) {
    const results = document.getElementById('results');
    const notFollowingBack = currentNotFollowingBack;
    const followingCount = currentFollowingCount;
    const followersCount = currentFollowersCount;

    currentPage = page;

    const totalItems = notFollowingBack.length;
    const itemsPerPage = CONFIG.ITEMS_PER_PAGE;
    const totalPages = Math.ceil(totalItems / itemsPerPage);

    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages || 1;

    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const usersToShow = notFollowingBack.slice(startIndex, endIndex);

    const notFollowingPercentage = followingCount > 0 ? 
      ((notFollowingBack.length / followingCount) * 100).toFixed(1) : '0';

    const listItems = usersToShow.map((username) => {
      const marked = window.IGFTStore ? window.IGFTStore.isDeactivated(username) : false;
      return `
      <li class="res-row" data-igft-row="${username}">
        <div class="res-row__main">
          <span class="res-avatar" aria-hidden="true">${username.charAt(0).toUpperCase()}</span>
          <span class="res-user">
            <span class="res-name">@${username}<span class="res-deactivated-tag" data-igft-tag ${marked ? '' : 'hidden'}>disattivato</span></span>
            <span class="res-handle">instagram.com/${username}</span>
          </span>
        </div>
        <div class="res-actions">
          <button type="button"
                  data-igft-toggle
                  class="res-btn res-btn--mark ${marked ? 'is-marked' : ''}"
                  onclick="window.IGFTToggleDeactivated('${username}')"
                  title="${marked ? 'Rimuovi dalla memoria dei disattivati' : 'Ricorda questo profilo e rimuovilo dalle prossime analisi'}">
            ${marked ? 'Ripristina' : 'Disattivato'}
          </button>
          <button type="button" class="res-btn res-btn--open"
                  onclick="window.open('https://instagram.com/${username}', '_blank', 'noopener')">
            Apri
          </button>
        </div>
      </li>
    `;
    }).join('');

    const saveNoteHtml = currentSaveNote
      ? `<div class="res-note res-note--${currentSaveNote.kind}">${window.IGFTCore.escapeHtml(currentSaveNote.text)}${currentSaveNote.showHistory ? '<button type="button" onclick="window.IGFTUI && window.IGFTUI.openLibrary(\'analyses\')">Apri storico</button>' : ''}</div>`
      : '';

    const manualSaveHtml = !storeStatus().autoSave
      ? '<div class="res-note res-note--info">Salvataggio automatico disattivato.<button type="button" onclick="window.IGFTSaveCurrentAnalysis()">Salva questa analisi</button></div>'
      : '';

    const removedNoteHtml = currentRemovedDeactivatedCount > 0
      ? `<div class="res-note res-note--deactivated">♻️ <strong>${currentRemovedDeactivatedCount}</strong> ${currentRemovedDeactivatedCount === 1 ? 'profilo disattivato è stato escluso' : 'profili disattivati sono stati esclusi'} automaticamente da questa analisi.</div>`
      : '';

    const paginationControls = totalPages > 1 ? `
      <div class="res-pagination">
        <button type="button" class="res-page-btn" onclick="window.updateResultsPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>← Precedente</button>
        <span class="res-page-label">Pagina ${page} di ${totalPages}</span>
        <button type="button" class="res-page-btn" onclick="window.updateResultsPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>Successivo →</button>
      </div>
    ` : '';

    const previousList = document.getElementById('igftResultsList');
    const previousScroll = previousList ? previousList.scrollTop : 0;

    results.innerHTML = `
      <div class="res-wrap">
        ${saveNoteHtml}
        ${manualSaveHtml}
        ${removedNoteHtml}

        <div class="res-card">
          <div class="res-stats">
            <div class="res-stat res-stat--info">
              <div class="res-stat__value">${followingCount}</div>
              <div class="res-stat__label">Following</div>
            </div>
            <div class="res-stat res-stat--success">
              <div class="res-stat__value">${followersCount}</div>
              <div class="res-stat__label">Followers</div>
            </div>
            <div class="res-stat res-stat--danger">
              <div class="res-stat__value">${notFollowingBack.length}</div>
              <div class="res-stat__label">Non ti seguono</div>
            </div>
          </div>
          <div class="res-summary">
            ${notFollowingBack.length > 0
              ? `<strong>${notFollowingBack.length}</strong> account su <strong>${followingCount}</strong> che segui non ti seguono (${notFollowingPercentage}%)`
              : '<strong>Tutti gli account che segui ti seguono a loro volta!</strong>'
            }
          </div>
        </div>

        ${notFollowingBack.length > 0 ? `
          <div class="res-card">
            <div class="res-card__head">
              <h3 class="res-card__title">Account che non ti seguono</h3>
              <span class="res-count">${totalItems}</span>
            </div>
            <div class="res-range">Mostrati da ${startIndex + 1} a ${endIndex} di ${totalItems}</div>
            <ul class="res-list" id="igftResultsList">
              ${listItems}
            </ul>
            ${paginationControls}
          </div>
        ` : `
          <div class="res-card res-empty">
            <div class="res-empty__icon" aria-hidden="true">🎉</div>
            <h3>Perfetto!</h3>
            <p>Tutti i tuoi ${followingCount} following ti seguono a loro volta.</p>
          </div>
        `}
      </div>
    `;

    const newList = document.getElementById('igftResultsList');
    if (newList && previousScroll) {
      newList.scrollTop = previousScroll;
    }
  }

  window.updateResultsPage = function(page) {
    displayResults(page);
  };

  function updateDeactivatedRow(username) {
    const marked = window.IGFTStore ? window.IGFTStore.isDeactivated(username) : false;
    document.querySelectorAll('[data-igft-row="' + username + '"]').forEach((row) => {
      const tag = row.querySelector('[data-igft-tag]');
      if (tag) tag.hidden = !marked;
      const button = row.querySelector('[data-igft-toggle]');
      if (button) {
        button.textContent = marked ? 'Ripristina' : 'Disattivato';
        button.classList.toggle('is-marked', marked);
        button.title = marked
          ? 'Rimuovi dalla memoria dei disattivati'
          : 'Ricorda questo profilo e rimuovilo dalle prossime analisi';
      }
    });
  }

  // Marca/ripristina un profilo come disattivato dopo l'analisi.
  window.IGFTToggleDeactivated = async function(username) {
    if (!window.IGFTStore) return;
    skipStoreRerender = true;
    try {
      const wasMarked = window.IGFTStore.isDeactivated(username);
      const result = await window.IGFTStore.toggleDeactivated(username);
      if (result && result.synced === false) {
        notifyUser('Salvato in coda: sincronizzazione con Firestore non disponibile, riproveremo automaticamente.', 'error');
      } else {
        notifyUser(
          wasMarked
            ? '@' + username + ' ripristinato.'
            : '@' + username + ' marcato come disattivato: sarà escluso dalle prossime analisi.',
          'success'
        );
      }
    } catch (error) {
      notifyUser('Operazione non riuscita: ' + (error.message || 'errore sconosciuto'), 'error');
    } finally {
      skipStoreRerender = false;
    }
    updateDeactivatedRow(username);
  };

  window.IGFTSaveCurrentAnalysis = async function() {
    const Store = window.IGFTStore;
    if (!Store || currentFollowingCount === 0) return;
    try {
      const saved = await Store.saveAnalysis({
        followingCount: currentFollowingCount,
        followersCount: currentFollowersCount,
        notFollowing: currentNotFollowingBack.slice(),
        removedDeactivatedCount: currentRemovedDeactivatedCount
      });
      currentSaveNote = {
        text: saved
          ? (saved.storage === 'cloud'
            ? 'Analisi salvata su Firestore.'
            : 'Analisi in coda: verrà sincronizzata su Firestore appena possibile.')
          : 'Salvataggio dell\'analisi non riuscito.',
        kind: saved ? 'success' : 'error',
        showHistory: true
      };
    } catch (error) {
      currentSaveNote = {
        text: 'Salvataggio dell\'analisi non riuscito: ' + (error.message || 'errore sconosciuto'),
        kind: 'error',
        showHistory: true
      };
    }
    displayResults(currentPage);
  };

  // ========== INIZIALIZZAZIONE (invariata) ==========
  loadJSZip().then(() => {
    const results = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');
    const zipInput = document.getElementById('zipfile');
    const dropzone = document.getElementById('dropzone');
    const resetBtn = document.getElementById('resetBtn');
    
    statusPill.textContent = '✅ Pronto';
    statusPill.className = 'pill success';
    
    results.innerHTML = `
      <div class="res-empty">
        <div class="res-empty__icon" aria-hidden="true">📊</div>
        <h3>Nessuna analisi ancora</h3>
        <p>Carica il file ZIP per vedere chi non ti segue più.</p>
      </div>
    `;
    
    if (zipInput) {
      zipInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else if (file) {
          alert('Per favore, seleziona un file ZIP scaricato da Instagram');
          this.value = '';
        }
      });
    }
    
    if (dropzone) {
      dropzone.addEventListener('click', (e) => {
        if (isProcessing) return;
        if (e.target === dropzone || e.target.classList.contains('upload-icon') || 
            e.target.classList.contains('upload-text')) {
          if (zipInput) zipInput.click();
        }
      });
      
      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          if (!isProcessing) dropzone.classList.add('drag-over');
        });
      });
      
      ['dragleave', 'drop'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.classList.remove('drag-over');
        });
      });
      
      dropzone.addEventListener('drop', e => {
        e.preventDefault();
        if (isProcessing) return;
        const file = e.dataTransfer.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else if (file) {
          alert('Per favore, rilascia un file ZIP scaricato da Instagram');
        }
      });
    }
    
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (isProcessing) return;
        currentNotFollowingBack = [];
        currentFollowingCount = 0;
        currentFollowersCount = 0;
        currentPage = 1;
        currentRemovedDeactivatedCount = 0;
        currentSaveNote = null;
        analysisSeq++;
        if (zipInput) {
          zipInput.value = '';
          zipInput.disabled = false;
        }
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
        results.innerHTML = `
          <div class="res-empty">
            <div class="res-empty__icon" aria-hidden="true">🔄</div>
            <h3>Pronto per una nuova analisi</h3>
            <p>Carica un nuovo file ZIP di Instagram.</p>
          </div>
        `;
      });
    }

    if (window.IGFTStore) {
      window.IGFTStore.onChange(function () {
        if (!skipStoreRerender && !isProcessing && currentFollowingCount > 0) {
          displayResults(currentPage);
        }
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento libreria:', error);
    const results = document.getElementById('results');
    results.innerHTML = `
      <div class="res-empty">
        <div class="res-empty__icon" aria-hidden="true">❌</div>
        <h3>Errore di caricamento</h3>
        <p>Impossibile caricare le risorse necessarie. Ricarica la pagina o controlla la connessione.</p>
      </div>
    `;
  });
});
