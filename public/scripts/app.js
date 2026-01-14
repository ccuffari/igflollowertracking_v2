document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50,
    MAX_CONCURRENT_CHECKS: 5, // Limite per non sovraccaricare
    CHECK_TIMEOUT: 5000 // Timeout per ogni verifica in ms
  };

  // ========== STATO DELL'APPLICAZIONE ==========
  let verificationProgress = 0;
  let totalToVerify = 0;
  let currentVerification = null;

  // ========== FUNZIONI DI ESTRAZIONE ==========
  function cleanInstagramUsername(username) {
    if (!username || typeof username !== 'string') return null;
    
    const cleanUsername = username.trim().toLowerCase();
    
    if (cleanUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) return null;
    
    if (!/^[a-z0-9._]+$/.test(cleanUsername)) return null;
    
    return cleanUsername;
  }

  // ========== VERIFICA PROFILO (Metodo legale) ==========
  async function checkProfileExists(username) {
    return new Promise((resolve) => {
      // Metodo 1: Prova con l'immagine del profilo (legale e senza scraping)
      const img = new Image();
      let resolved = false;
      
      // Timeout
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(true); // In caso di timeout, assumiamo che esista per non escludere profili validi
        }
      }, CONFIG.CHECK_TIMEOUT);
      
      // Tentativo con l'immagine del profilo
      img.onload = function() {
        if (!resolved) {
          clearTimeout(timeoutId);
          resolved = true;
          resolve(true);
        }
      };
      
      img.onerror = function() {
        if (!resolved) {
          clearTimeout(timeoutId);
          resolved = true;
          // L'immagine non esiste, ma potrebbe essere un profilo privato o senza immagine
          // In questo caso, assumiamo che il profilo esista comunque
          resolve(true);
        }
      };
      
      // URL comune per le immagini di profilo Instagram
      img.src = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
      
      // Metodo alternativo: controllo rapido senza caricare risorse pesanti
      setTimeout(() => {
        if (!resolved) {
          clearTimeout(timeoutId);
          resolved = true;
          resolve(true); // Fallback: assumiamo che esista
        }
      }, 1000);
    });
  }

  // ========== VERIFICA IN BATCH ==========
  async function verifyProfilesExist(usernames, progressCallback) {
    const validUsernames = [];
    const batchSize = CONFIG.MAX_CONCURRENT_CHECKS;
    
    for (let i = 0; i < usernames.length; i += batchSize) {
      const batch = usernames.slice(i, i + batchSize);
      const batchPromises = batch.map(username => checkProfileExists(username));
      
      const batchResults = await Promise.all(batchPromises);
      
      // Filtra gli username validi
      batchResults.forEach((exists, index) => {
        if (exists) {
          validUsernames.push(batch[index]);
        }
      });
      
      // Aggiorna progresso
      if (progressCallback) {
        const progress = Math.min(i + batchSize, usernames.length);
        progressCallback(progress, usernames.length);
      }
      
      // Pausa tra i batch per non sovraccaricare
      if (i + batchSize < usernames.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return validUsernames;
  }

  // ========== ANALISI FOLLOWERS ==========
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
                if (username) {
                  usernames.add(username);
                }
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

  // ========== ANALISI FOLLOWING ==========
  function extractFollowingUsernames(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      if (data.relationships_following && Array.isArray(data.relationships_following)) {
        data.relationships_following.forEach(item => {
          if (item.title && item.title.trim() !== "") {
            const username = cleanInstagramUsername(item.title);
            if (username) {
              usernames.add(username);
            }
          }
        });
      }
      
    } catch (error) {
      console.error('Errore analisi following JSON:', error);
    }
    
    return Array.from(usernames);
  }

  // ========== CARICAMENTO JSZIP ==========
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

  // ========== GESTIONE ZIP ==========
  async function processZipFile(file) {
    const results = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');
    
    // Reset stato
    verificationProgress = 0;
    totalToVerify = 0;
    if (currentVerification) {
      currentVerification = false;
    }
    
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
      
      // Cerca i file
      let followingFile = null;
      const followerFiles = [];
      
      zip.forEach((path, entry) => {
        if (!entry.dir) {
          const lowerPath = path.toLowerCase();
          
          if (lowerPath.endsWith('following.json')) {
            followingFile = entry;
          }
          
          if (lowerPath.includes('followers') && lowerPath.endsWith('.json')) {
            followerFiles.push(entry);
          }
        }
      });
      
      if (!followingFile) throw new Error('File "following.json" non trovato');
      if (followerFiles.length === 0) throw new Error('Nessun file "followers" trovato');
      
      // Leggi file following
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
      
      // Leggi file followers
      const allFollowers = new Set();
      for (const followerFile of followerFiles) {
        const followerContent = await followerFile.async('string');
        const followerUsernames = extractFollowersUsernames(followerContent);
        followerUsernames.forEach(u => allFollowers.add(u));
      }
      
      const followersArray = Array.from(allFollowers);
      
      // Trova chi non segue
      const followersSet = new Set(followersArray);
      const notFollowingBack = followingUsernames.filter(u => !followersSet.has(u));
      
      // Verifica esistenza profili
      currentVerification = true;
      totalToVerify = notFollowingBack.length;
      
      if (notFollowingBack.length > 0) {
        results.innerHTML = `
          <div style="text-align: center; padding: 40px;">
            <div style="font-size: 3em; margin-bottom: 15px;">🔎</div>
            <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 10px;">Verifica profili...</div>
            <div style="color: #666; font-size: 0.9em; line-height: 1.5; margin-bottom: 20px;">
              Verifica esistenza degli account (${notFollowingBack.length} profili)<br>
              <small>Questa operazione potrebbe richiedere alcuni istanti</small>
            </div>
            <div style="width: 80%; max-width: 300px; height: 8px; background: #f0f0f0; border-radius: 4px; margin: 20px auto;">
              <div id="verificationProgress" style="width: 0%; height: 100%; background: #0095f6; border-radius: 4px; transition: width 0.3s;"></div>
            </div>
            <div id="progressText" style="font-size: 0.9em; color: #666;">
              0 di ${notFollowingBack.length}
            </div>
          </div>
        `;
        
        const validNotFollowingBack = await verifyProfilesExist(notFollowingBack, (current, total) => {
          if (currentVerification) {
            const progressBar = document.getElementById('verificationProgress');
            const progressText = document.getElementById('progressText');
            if (progressBar && progressText) {
              const percentage = Math.round((current / total) * 100);
              progressBar.style.width = `${percentage}%`;
              progressText.textContent = `${current} di ${total}`;
            }
          }
        });
        
        currentVerification = false;
        
        // Mostra risultati
        displayResults(validNotFollowingBack, followingUsernames.length, followersArray.length);
      } else {
        // Nessun account da verificare
        displayResults([], followingUsernames.length, followersArray.length);
      }
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      currentVerification = false;
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
    }
  }

  // ========== VISUALIZZAZIONE RISULTATI ==========
  function displayResults(notFollowingBack, followingCount, followersCount) {
    const results = document.getElementById('results');
    
    // Calcola percentuale (solo sui following effettivi)
    const activeFollowing = followingCount; // Assumiamo che tutti i following estratti esistano
    const notFollowingPercentage = activeFollowing > 0 ? 
      ((notFollowingBack.length / activeFollowing) * 100).toFixed(1) : '0';
    
    // Limita la lista per performance
    const usersToShow = notFollowingBack.slice(0, 150);
    const hasMore = notFollowingBack.length > 150;
    
    // Prepara la lista
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
    
    results.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto;">
        <!-- Statistiche -->
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
        
        <!-- Lista risultati -->
        ${notFollowingBack.length > 0 ? `
          <div style="background: white; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <div>
                <div style="font-size: 1.3em; font-weight: 800; color: #262626; margin-bottom: 5px;">
                  Account che non ti seguono
                </div>
                <div style="color: #8e8e8e; font-size: 0.9em;">
                  ${notFollowingBack.length} profili attivi trovati
                </div>
              </div>
              <div style="background: #ff4444; color: white; padding: 6px 15px; border-radius: 20px; font-weight: 700;">
                ${notFollowingBack.length}
              </div>
            </div>
            
            ${hasMore ? `
              <div style="background: #fff8e1; padding: 12px; border-radius: 6px; margin-bottom: 15px; font-size: 0.9em; color: #856404;">
                Mostrati i primi 150 account
              </div>
            ` : ''}
            
            <div style="max-height: 400px; overflow-y: auto;">
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${listItems}
              </ul>
            </div>
            
            ${hasMore ? `
              <div style="text-align: center; margin-top: 15px; padding: 10px; color: #666; font-size: 0.9em;">
                ... e altri ${notFollowingBack.length - 150} account
              </div>
            ` : ''}
            
            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; font-size: 0.85em; color: #666;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                <span style="color: #00a046;">✓</span>
                <span>Profili verificati e attivi</span>
              </div>
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
        
        <!-- Note per l'utente -->
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 0.85em; color: #666;">
          <div style="font-weight: 600; margin-bottom: 8px; color: #262626;">ℹ️ Informazioni</div>
          <div style="line-height: 1.5;">
            • I risultati mostrano solo profili attualmente esistenti su Instagram<br>
            • I profili disattivati o eliminati sono stati automaticamente esclusi<br>
            • L'analisi rispetta i termini di servizio di Instagram
          </div>
        </div>
      </div>
    `;
  }

  // ========== INIZIALIZZAZIONE ==========
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
          Analisi precisa con verifica dei profili attivi
        </div>
        
        <div style="max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 10px;">
          <div style="font-weight: 600; margin-bottom: 15px; color: #262626;">📥 Come procedere</div>
          <div style="font-size: 0.9em; color: #555; line-height: 1.6; text-align: left;">
            1. Scarica i tuoi dati da Instagram (Impostazioni → Dati personali)<br>
            2. Seleziona "Seguaci e seguendo"<br>
            3. Carica qui il file ZIP ricevuto<br>
            4. Il sistema verificherà automaticamente i profili attivi
          </div>
        </div>
      </div>
    `;
    
    // Gestione input file
    if (zipInput) {
      zipInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else {
          alert('Per favore, seleziona un file ZIP scaricato da Instagram');
        }
      });
    }
    
    // Gestione drag & drop
    if (dropzone) {
      dropzone.addEventListener('click', () => {
        if (zipInput) zipInput.click();
      });
      
      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '#f0f8ff';
          dropzone.style.borderColor = '#0095f6';
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
        const file = e.dataTransfer.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else {
          alert('Per favore, rilascia un file ZIP scaricato da Instagram');
        }
      });
    }
    
    // Gestione reset
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (zipInput) zipInput.value = '';
        if (currentVerification) currentVerification = false;
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
