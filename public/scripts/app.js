document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50,
    ITEMS_PER_PAGE: 100,
    VERIFY_BATCH_SIZE: 3,                     // ridotto per evitare troppe richieste parallele
    VERIFY_TIMEOUT: 10000,                    // timeout aumentato
    PROXY_LIST: [                             // lista di proxy CORS gratuiti
      'https://api.allorigins.win/get?url=',
      'https://corsproxy.io/?',
      'https://api.codetabs.com/v1/proxy/?quest='
    ]
  };

  // ========== STATO DELL'APPLICAZIONE ==========
  let isProcessing = false;
  let currentNotFollowingBack = [];
  let currentFollowingCount = 0;
  let currentFollowersCount = 0;
  let verificationSkipped = false;        // flag se la verifica è stata saltata (volontariamente o per errore)
  let verificationFailed = false;          // flag se la verifica è fallita del tutto
  let verifiedList = [];                   // lista dopo verifica

  // ========== FUNZIONI DI ESTRAZIONE (invariate) ==========
  function cleanInstagramUsername(username) {
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

  // ========== VERIFICA ESISTENZA PROFILO CON MULTI-PROXY ==========
  async function checkUsernameWithProxy(username, proxyIndex = 0) {
    if (proxyIndex >= CONFIG.PROXY_LIST.length) {
      return { exists: false, error: 'Tutti i proxy hanno fallito' };
    }

    const url = `https://www.instagram.com/${username}/`;
    const proxyUrl = CONFIG.PROXY_LIST[proxyIndex] + encodeURIComponent(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.VERIFY_TIMEOUT);

    try {
      const response = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        // Prova con il proxy successivo
        return checkUsernameWithProxy(username, proxyIndex + 1);
      }

      const data = await response.json();
      // Adatta in base alla struttura del proxy
      let html = '';
      if (data.contents) html = data.contents;         // allorigins
      else if (typeof data === 'string') html = data;  // corsproxy restituisce direttamente HTML
      else html = data.toString();

      // Cerca pattern di pagina non trovata
      const lowerHtml = html.toLowerCase();
      const notFoundPatterns = [
        'sorry, this page isn\'t available',
        'the link you followed may be broken',
        'page may have been removed',
        'pagina non trovata',
        'la pagina che hai cercato non è disponibile',
        'content="0; url=/challenge/"'  // redirect a challenge (account sospeso?)
      ];

      const isNotFound = notFoundPatterns.some(pattern => lowerHtml.includes(pattern));

      // Inoltre controlla il titolo
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].toLowerCase() : '';
      if (title.includes('page not found') || title.includes('pagina non trovata')) {
        return { exists: false, proxyIndex };
      }

      if (isNotFound) {
        return { exists: false, proxyIndex };
      }

      // Se non rileviamo pattern di errore, assumiamo che il profilo esista
      return { exists: true, proxyIndex };
    } catch (error) {
      clearTimeout(timeoutId);
      // Errore di rete o timeout, prova il proxy successivo
      return checkUsernameWithProxy(username, proxyIndex + 1);
    }
  }

  // ========== VERIFICA BATCH CON PROGRESS ==========
  async function verifyAndFilterUsernames(usernames, onProgress) {
    const results = [];
    const total = usernames.length;
    let processed = 0;
    let failedCount = 0;

    for (let i = 0; i < usernames.length; i += CONFIG.VERIFY_BATCH_SIZE) {
      const batch = usernames.slice(i, i + CONFIG.VERIFY_BATCH_SIZE);
      const batchPromises = batch.map(async (username) => {
        const result = await checkUsernameWithProxy(username);
        processed++;
        onProgress(processed, total, username, result.exists ? 'esiste' : 'inesistente/errore');
        if (result.exists) {
          return username;
        } else {
          failedCount++;
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return { verifiedList: results, failedCount };
  }

  // ========== FUNZIONE PER AVVIARE LA VERIFICA MANUALMENTE ==========
  window.startVerification = async function() {
    if (isProcessing || currentNotFollowingBack.length === 0) return;

    const resultsDiv = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');

    isProcessing = true;
    verificationSkipped = false;
    verificationFailed = false;

    statusPill.textContent = '🔄 Verifica...';
    statusPill.className = 'pill processing';

    // Mostra UI di progresso
    resultsDiv.innerHTML = `
      <div style="text-align: center; padding: 30px;">
        <div style="font-size: 2.5em; margin-bottom: 15px;">🔎</div>
        <div style="font-size: 1.3em; font-weight: bold; margin-bottom: 10px;">Verifica account esistenti...</div>
        <div style="color: #666; margin-bottom: 20px;">
          Controllo quali profili esistono ancora su Instagram. Questa operazione può richiedere fino a un minuto.
        </div>
        <div id="verifyProgress" style="background: #e0e0e0; border-radius: 10px; height: 20px; width: 80%; margin: 0 auto; overflow: hidden;">
          <div id="verifyProgressBar" style="width: 0%; height: 100%; background: #0095f6; transition: width 0.3s;"></div>
        </div>
        <div id="verifyStatus" style="margin-top: 10px; color: #555; font-size: 0.9em;"></div>
      </div>
    `;

    const progressBar = document.getElementById('verifyProgressBar');
    const statusEl = document.getElementById('verifyStatus');

    const onProgress = (processed, total, username, state) => {
      const percent = (processed / total) * 100;
      if (progressBar) progressBar.style.width = percent + '%';
      if (statusEl) statusEl.textContent = `Controllo ${processed} di ${total} (${username} - ${state})`;
    };

    try {
      const { verifiedList, failedCount } = await verifyAndFilterUsernames(currentNotFollowingBack, onProgress);
      
      // Aggiorna la lista corrente
      currentNotFollowingBack = verifiedList;
      
      if (failedCount > 0) {
        verificationFailed = true;  // per mostrare un avviso
      }

      statusPill.textContent = '✅ Verifica completata';
      statusPill.className = 'pill success';
    } catch (error) {
      console.error('Errore durante la verifica:', error);
      verificationSkipped = true; // usiamo questo flag per indicare che la verifica non è riuscita
      statusPill.textContent = '⚠️ Verifica fallita';
      statusPill.className = 'pill error';
    } finally {
      isProcessing = false;
      displayResults(1);  // aggiorna la visualizzazione con la lista (eventualmente filtrata)
    }
  };

  // ========== GESTIONE ZIP (modificata per non fare verifica automatica) ==========
  async function processZipFile(file) {
    if (isProcessing) return;
    
    const results = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');
    const zipInput = document.getElementById('zipfile');
    
    if (zipInput) zipInput.disabled = true;
    isProcessing = true;
    verificationSkipped = false;
    verificationFailed = false;
    
    statusPill.textContent = '🔄 Analisi...';
    statusPill.className = 'pill processing';
    results.innerHTML = `
      <div style="text-align: center; padding: 40px;">
        <div style="font-size: 3em; margin-bottom: 15px;">📁</div>
        <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 10px;">Caricamento file...</div>
        <div style="color: #666; font-size: 0.9em; line-height: 1.5;">
          Analisi del file ZIP in corso<br>
          Questa operazione potrebbe richiedere alcuni secondi
        </div>
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
        <div style="text-align: center; padding: 40px;">
          <div style="font-size: 3em; margin-bottom: 15px;">🔍</div>
          <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 10px;">Analisi dati...</div>
          <div style="color: #666; font-size: 0.9em; line-height: 1.5;">
            Estrazione delle informazioni dagli account
          </div>
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

      // NON eseguiamo verifica automatica, lasciamo all'utente la scelta
      currentNotFollowingBack = notFollowingBack;
      currentFollowingCount = followingUsernames.length;
      currentFollowersCount = followersArray.length;
      
      // Mostra risultati con pagina 1 (senza verifica)
      displayResults(1);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div style="text-align: center; padding: 40px; background: #fff3f3; border-radius: 12px;">
          <div style="font-size: 3em; margin-bottom: 20px;">⚠️</div>
          <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 15px; color: #d32f2f;">Si è verificato un errore</div>
          <div style="color: #666; margin-bottom: 20px; line-height: 1.5;">
            ${error.message || 'Errore durante l\'analisi del file'}
          </div>
          <div style="font-size: 0.9em; color: #999;">
            Assicurati di aver caricato il file ZIP corretto scaricato da Instagram
          </div>
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

    // Avvisi in base allo stato della verifica
    let verificationSection = '';
    if (totalItems > 0) {
      if (verificationFailed) {
        verificationSection = `
          <div style="background: #fff3cd; border: 1px solid #ffecb5; border-radius: 8px; padding: 12px; margin-bottom: 20px; color: #856404;">
            ⚠️ <strong>Verifica parziale:</strong> alcuni account non hanno potuto essere verificati a causa di errori di rete. La lista potrebbe ancora contenere profili inesistenti.
          </div>
        `;
      } else if (verificationSkipped) {
        verificationSection = `
          <div style="background: #fff3cd; border: 1px solid #ffecb5; border-radius: 8px; padding: 12px; margin-bottom: 20px; color: #856404;">
            ⚠️ <strong>Verifica non eseguita:</strong> la verifica automatica è stata saltata. Puoi avviarla manualmente con il pulsante qui sotto.
          </div>
        `;
      } else {
        // Nessuna verifica eseguita, mostriamo il pulsante
        verificationSection = `
          <div style="background: #e8f4fd; border: 1px solid #b6d4fe; border-radius: 8px; padding: 15px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
            <span style="color: #084298;">🔎 La lista potrebbe includere account inesistenti. Vuoi verificare quali profili esistono ancora?</span>
            <button id="verifyBtn" class="ig-btn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #0095f6; color: white; cursor: pointer; font-weight: 500;">Avvia verifica (lento)</button>
          </div>
        `;
      }
    }

    const listItems = usersToShow.map((username, index) => `
      <li style="padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
          <div style="flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%; background: #f0f0f0; 
                      display: flex; align-items: center; justify-content: center; font-weight: bold;">
            ${username.charAt(0).toUpperCase()}
          </div>
          <div style="min-width: 0; flex: 1;">
            <div style="font-weight: 600; color: #262626; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              @${username}
            </div>
            <div style="color: #8e8e8e; text-decoration: none; font-size: 0.8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              instagram.com/${username}
            </div>
          </div>
        </div>
        <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                style="flex-shrink: 0; padding: 6px 15px; background: #0095f6; color: white; border: none; 
                       border-radius: 6px; cursor: pointer; font-size: 0.9em; font-weight: 500;">
          Vedi
        </button>
      </li>
    `).join('');

    const paginationControls = totalPages > 1 ? `
      <div style="display: flex; justify-content: center; align-items: center; gap: 15px; margin: 20px 0 10px;">
        <button 
          onclick="window.updateResultsPage(${page - 1})" 
          ${page === 1 ? 'disabled' : ''}
          style="padding: 8px 16px; background: ${page === 1 ? '#ccc' : '#0095f6'}; color: white; border: none; border-radius: 6px; cursor: ${page === 1 ? 'not-allowed' : 'pointer'}; font-weight: 500;">
          ← Precedente
        </button>
        <span style="font-weight: 500; color: #262626;">
          Pagina ${page} di ${totalPages}
        </span>
        <button 
          onclick="window.updateResultsPage(${page + 1})" 
          ${page === totalPages ? 'disabled' : ''}
          style="padding: 8px 16px; background: ${page === totalPages ? '#ccc' : '#0095f6'}; color: white; border: none; border-radius: 6px; cursor: ${page === totalPages ? 'not-allowed' : 'pointer'}; font-weight: 500;">
          Successivo →
        </button>
      </div>
    ` : '';

    results.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto;">
        <!-- NOTA INFORMATIVA (invariata) -->
        <div style="background: #e8f4fd; border: 1px solid #b6d4fe; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
          <div style="display: flex; align-items: flex-start; gap: 15px;">
            <div style="flex-shrink: 0; font-size: 1.5em; color: #0d6efd;">ℹ️</div>
            <div style="flex: 1;">
              <div style="font-size: 1.1em; font-weight: 600; color: #0a58ca; margin-bottom: 10px;">
                Informazioni sui risultati
              </div>
              <div style="color: #084298; line-height: 1.6; font-size: 0.95em;">
                <p style="margin-bottom: 10px;">
                  I risultati mostrano gli account presenti nel file di esportazione che non ricambiano il follow.
                </p>
                <p style="margin-bottom: 10px;">
                  <strong>Nota importante:</strong> La lista può includere account disattivati o eliminati. 
                  Puoi avviare una verifica automatica (lenta) per rimuovere quelli inesistenti.
                </p>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Statistiche (invariate) -->
        <div style="background: white; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 25px;">
            <div style="font-size: 1.8em; font-weight: 800; margin-bottom: 10px; color: #262626;">
              📊 Risultati dell'analisi
            </div>
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 25px;">
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 2.5em; font-weight: 800; color: #0095f6; margin-bottom: 5px;">${followingCount}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.9em;">Following</div>
            </div>
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 2.5em; font-weight: 800; color: #00a046; margin-bottom: 5px;">${followersCount}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.9em;">Followers</div>
            </div>
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 2.5em; font-weight: 800; color: #ff4444; margin-bottom: 5px;">${notFollowingBack.length}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.9em;">Non ti seguono</div>
            </div>
          </div>
          
          <div style="background: #f0f8ff; padding: 15px; border-radius: 8px; text-align: center; border-left: 4px solid #0095f6;">
            <div style="font-size: 0.95em; color: #37474f; line-height: 1.5;">
              ${notFollowingBack.length > 0 ? 
                `<strong>${notFollowingBack.length}</strong> account su <strong>${followingCount}</strong> che segui non ti seguono (${notFollowingPercentage}%)` :
                `<strong>Tutti gli account che segui ti seguono a loro volta!</strong>`
              }
            </div>
          </div>
        </div>
        
        <!-- Sezione verifica (solo se ci sono account) -->
        ${verificationSection}
        
        <!-- Lista risultati -->
        ${notFollowingBack.length > 0 ? `
          <div style="background: white; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
              <div>
                <div style="font-size: 1.3em; font-weight: 800; color: #262626; margin-bottom: 5px;">
                  Account che non ti seguono
                </div>
                <div style="color: #8e8e8e; font-size: 0.9em;">
                  ${totalItems} account
                </div>
              </div>
              <div style="background: #ff4444; color: white; padding: 6px 15px; border-radius: 20px; font-weight: 700;">
                ${totalItems}
              </div>
            </div>
            
            <div style="background: #fff8e1; padding: 8px 12px; border-radius: 6px; margin-bottom: 15px; font-size: 0.9em; color: #856404;">
              Mostrati da ${startIndex + 1} a ${endIndex} di ${totalItems} account
            </div>
            
            <div style="max-height: 400px; overflow-y: auto;">
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${listItems}
              </ul>
            </div>
            
            ${paginationControls}
            
            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; font-size: 0.85em; color: #666;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="color: #0095f6;">↗</span>
                <span>Clicca "Vedi" per aprire il profilo su Instagram</span>
              </div>
            </div>
          </div>
        ` : `
          <div style="text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
            <div style="font-size: 1.5em; font-weight: 800; margin-bottom: 10px; color: #262626;">
              Perfetto!
            </div>
            <div style="color: #666; margin-bottom: 25px; line-height: 1.5;">
              Tutti i tuoi ${followingCount} following ti seguono a loro volta
            </div>
            <div style="background: #f0f8ff; padding: 15px; border-radius: 8px; display: inline-block;">
              <div style="font-size: 1.1em;">
                <span style="color: #0095f6; font-weight: 700;">${followingCount}</span> following → 
                <span style="color: #00a046; font-weight: 700;">${followersCount}</span> followers
              </div>
            </div>
          </div>
        `}
        
        <!-- Note tecniche (aggiornate) -->
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 0.85em; color: #666;">
          <div style="font-weight: 600; margin-bottom: 8px; color: #262626;">ℹ️ Note tecniche</div>
          <div style="line-height: 1.5;">
            • I dati sono estratti direttamente dal file di esportazione di Instagram<br>
            • La verifica online degli account è disponibile su richiesta (pulsante) ma può essere lenta e non garantita al 100% a causa di blocchi di Instagram<br>
            • Gli account verificati come inesistenti vengono rimossi dalla lista<br>
            • Per risultati ottimali, si consiglia di scaricare un file di esportazione aggiornato
          </div>
        </div>
      </div>
    `;

    // Aggiungi event listener al pulsante di verifica se presente
    const verifyBtn = document.getElementById('verifyBtn');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', window.startVerification);
    }
  }

  window.updateResultsPage = function(page) {
    displayResults(page);
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
      <div style="text-align: center; padding: 40px;">
        <div style="font-size: 3.5em; margin-bottom: 20px;">📊</div>
        <div style="font-size: 1.6em; font-weight: 800; margin-bottom: 10px; color: #262626;">
          Analizzatore Instagram
        </div>
        <div style="color: #666; margin-bottom: 25px; line-height: 1.5;">
          Scopri chi non ti segue su Instagram<br>
          Analisi rapida basata sui dati ufficiali
        </div>
        
        <div style="max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 10px;">
          <div style="font-weight: 600; margin-bottom: 15px; color: #262626;">📥 Come procedere</div>
          <div style="font-size: 0.9em; color: #555; line-height: 1.6; text-align: left;">
            1. Scarica i tuoi dati da Instagram (Impostazioni → Dati personali)<br>
            2. Seleziona "Seguaci e seguendo"<br>
            3. Carica qui il file ZIP ricevuto<br>
            4. Visualizza immediatamente i risultati
          </div>
        </div>
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
          if (!isProcessing) {
            dropzone.style.background = '#f0f8ff';
            dropzone.style.borderColor = '#0095f6';
          }
        });
      });
      
      ['dragleave', 'drop'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '';
          dropzone.style.borderColor = '';
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
        verificationSkipped = false;
        verificationFailed = false;
        if (zipInput) {
          zipInput.value = '';
          zipInput.disabled = false;
        }
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
        results.innerHTML = `
          <div style="text-align: center; padding: 40px;">
            <div style="font-size: 3.5em; margin-bottom: 20px;">🔄</div>
            <div style="font-size: 1.6em; font-weight: 800; margin-bottom: 10px; color: #262626;">
              Pronto per una nuova analisi
            </div>
            <div style="color: #666;">
              Carica un nuovo file ZIP di Instagram
            </div>
          </div>
        `;
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento libreria:', error);
    const results = document.getElementById('results');
    results.innerHTML = `
      <div style="text-align: center; padding: 40px; background: #fff3f3; border-radius: 12px;">
        <div style="font-size: 3em; margin-bottom: 20px;">❌</div>
        <div style="font-size: 1.4em; font-weight: bold; margin-bottom: 15px; color: #d32f2f;">Errore di caricamento</div>
        <div style="color: #666; line-height: 1.5;">
          Impossibile caricare le risorse necessarie<br>
          Ricarica la pagina o controlla la connessione
        </div>
      </div>
    `;
  });
});
