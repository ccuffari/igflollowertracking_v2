document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50
  };

  // ========== FUNZIONI DI ESTRAZIONE ==========
  function extractUsernameFromValue(value) {
    if (!value) return null;
    
    const strValue = String(value).trim().toLowerCase();
    
    // Rimuovi caratteri speciali e spazi
    const cleanUsername = strValue.replace(/[^a-z0-9._]/g, '');
    
    if (cleanUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) return null;
    
    // Controlla formato Instagram
    if (!/^[a-z0-9._]+$/.test(cleanUsername)) return null;
    
    return cleanUsername;
  }

  function extractUsernameFromHref(href) {
    if (!href) return null;
    
    const strValue = String(href).trim().toLowerCase();
    
    // Pattern per estrarre username da URL Instagram
    const patterns = [
      /instagram\.com\/_u\/([a-z0-9._]+)/i,
      /instagram\.com\/([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/_u\/([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/([a-z0-9._]+)/i
    ];
    
    for (const pattern of patterns) {
      const match = strValue.match(pattern);
      if (match && match[1]) {
        const username = match[1].toLowerCase();
        if (username.length >= CONFIG.MIN_USERNAME_LENGTH && 
            username.length <= CONFIG.MAX_USERNAME_LENGTH) {
          return username;
        }
      }
    }
    
    return null;
  }

  // ========== ANALISI SPECIFICA PER FOLLOWERS ==========
  function extractUsernamesFromFollowersJson(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      if (Array.isArray(data)) {
        data.forEach(item => {
          // Cerca in string_list_data -> value (questo è il campo per followers)
          if (item.string_list_data && Array.isArray(item.string_list_data)) {
            item.string_list_data.forEach(stringItem => {
              if (stringItem.value) {
                const username = extractUsernameFromValue(stringItem.value);
                if (username) usernames.add(username);
              }
              // Anche dall'href come fallback
              if (stringItem.href) {
                const username = extractUsernameFromHref(stringItem.href);
                if (username) usernames.add(username);
              }
            });
          }
          
          // Cerca anche nel campo title per sicurezza
          if (item.title) {
            const username = extractUsernameFromValue(item.title);
            if (username) usernames.add(username);
          }
        });
      }
      
    } catch (error) {
      console.error('Errore analisi followers JSON:', error);
    }
    
    return Array.from(usernames);
  }

  // ========== ANALISI SPECIFICA PER FOLLOWING ==========
  function extractUsernamesFromFollowingJson(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      if (Array.isArray(data)) {
        data.forEach(item => {
          // PRIMA priorità: campo title (questo è il campo principale per following)
          if (item.title) {
            const username = extractUsernameFromValue(item.title);
            if (username) usernames.add(username);
          }
          
          // SECONDA priorità: href in string_list_data
          if (item.string_list_data && Array.isArray(item.string_list_data)) {
            item.string_list_data.forEach(stringItem => {
              if (stringItem.href) {
                const username = extractUsernameFromHref(stringItem.href);
                if (username) usernames.add(username);
              }
              // Anche dal value se presente
              if (stringItem.value) {
                const username = extractUsernameFromValue(stringItem.value);
                if (username) usernames.add(username);
              }
            });
          }
          
          // Cerca anche in altri campi per sicurezza
          if (item.href) {
            const username = extractUsernameFromHref(item.href);
            if (username) usernames.add(username);
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
    
    statusPill.textContent = '🔄 Analisi...';
    statusPill.className = 'pill processing';
    results.innerHTML = `
      <div style="text-align: center; padding: 30px;">
        <div style="font-size: 3em; margin-bottom: 10px;">🔍</div>
        <div style="font-weight: bold; margin-bottom: 5px;">Analisi in corso...</div>
        <div style="color: #666; font-size: 0.9em;">
          Estrazione dei dati dal file ZIP<br>
          <small>Questa operazione potrebbe richiedere alcuni secondi</small>
        </div>
      </div>
    `;
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      
      // Cerca i file
      let followingFiles = [];
      let followerFiles = [];
      
      zip.forEach((path, entry) => {
        if (!entry.dir) {
          const lowerPath = path.toLowerCase();
          
          if (lowerPath.includes('following') && (lowerPath.endsWith('.json') || lowerPath.includes('.json'))) {
            followingFiles.push(entry);
          }
          
          if ((lowerPath.includes('follower') || lowerPath.includes('followers')) && 
              (lowerPath.endsWith('.json') || lowerPath.includes('.json'))) {
            followerFiles.push(entry);
          }
        }
      });
      
      if (followingFiles.length === 0) throw new Error('Nessun file "following" trovato nel ZIP');
      if (followerFiles.length === 0) throw new Error('Nessun file "follower" trovato nel ZIP');
      
      // Leggi tutti i file following
      const allFollowing = new Set();
      for (const file of followingFiles) {
        const content = await file.async('string');
        const usernames = extractUsernamesFromFollowingJson(content);
        usernames.forEach(u => allFollowing.add(u));
      }
      
      // Leggi tutti i file follower
      const allFollowers = new Set();
      for (const file of followerFiles) {
        const content = await file.async('string');
        const usernames = extractUsernamesFromFollowersJson(content);
        usernames.forEach(u => allFollowers.add(u));
      }
      
      const followingArray = Array.from(allFollowing);
      const followersArray = Array.from(allFollowers);
      
      // Debug: mostra quanti username abbiamo estratto
      console.log('Following estratti:', followingArray.length);
      console.log('Followers estratti:', followersArray.length);
      
      // Trova chi non segue
      const notFollowingBack = followingArray.filter(username => !allFollowers.has(username));
      
      // Mostra risultati
      displayResults(notFollowingBack, followingArray.length, followersArray.length);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div style="text-align: center; padding: 30px; background: #ffebee; border-radius: 10px;">
          <div style="font-size: 3em; margin-bottom: 10px;">⚠️</div>
          <div style="font-weight: bold; margin-bottom: 10px;">Errore nell'analisi</div>
          <div style="color: #666; margin-bottom: 15px;">${error.message}</div>
          <div style="font-size: 0.9em; color: #999;">
            File trovati nel ZIP:<br>
            - Following: ${followingFiles ? followingFiles.length : 0} file<br>
            - Followers: ${followerFiles ? followerFiles.length : 0} file<br><br>
            Assicurati di caricare il file ZIP scaricato da Instagram
          </div>
        </div>
      `;
    }
  }

  // ========== VISUALIZZAZIONE RISULTATI ==========
  function displayResults(notFollowingBack, followingCount, followersCount) {
    const results = document.getElementById('results');
    
    // Calcola percentuale
    const notFollowingPercentage = followingCount > 0 ? 
      ((notFollowingBack.length / followingCount) * 100).toFixed(1) : '0';
    
    // Limita la lista a 200 elementi per performance
    const usersToShow = notFollowingBack.slice(0, 200);
    const hasMore = notFollowingBack.length > 200;
    
    // Prepara la lista
    const listItems = usersToShow.map(username => `
      <li style="padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
          <div style="flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%; background: #f0f0f0; 
                      display: flex; align-items: center; justify-content: center; font-weight: bold;">
            ${username.charAt(0).toUpperCase()}
          </div>
          <div style="min-width: 0; overflow: hidden;">
            <div style="font-weight: bold; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">@${username}</div>
            <a href="https://instagram.com/${username}" target="_blank" 
               style="color: #666; text-decoration: none; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;">
              instagram.com/${username}
            </a>
          </div>
        </div>
        <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                style="flex-shrink: 0; padding: 6px 12px; background: #0095f6; color: white; border: none; 
                       border-radius: 4px; cursor: pointer; font-size: 0.85em; margin-left: 10px;">
          Vedi
        </button>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto;">
        <!-- Statistiche -->
        <div style="background: white; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 20px; text-align: center; color: #262626;">
            📊 Risultati Analisi Instagram
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 25px;">
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.8em; font-weight: bold; color: #0095f6; margin-bottom: 5px;">${followingCount}</div>
              <div style="color: #666; font-size: 0.95em;">Account che segui</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.8em; font-weight: bold; color: #00a046; margin-bottom: 5px;">${followersCount}</div>
              <div style="color: #666; font-size: 0.95em;">Account che ti seguono</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.8em; font-weight: bold; color: #ff4444; margin-bottom: 5px;">${notFollowingBack.length}</div>
              <div style="color: #666; font-size: 0.95em;">Non ti seguono</div>
            </div>
          </div>
          
          <div style="background: #f0f8ff; padding: 15px; border-radius: 8px; text-align: center; border-left: 4px solid #0095f6;">
            <div style="font-weight: bold; margin-bottom: 8px; color: #0095f6;">📈 Statistiche dettagliate</div>
            <div style="font-size: 0.95em; color: #555;">
              <strong>${notFollowingBack.length}</strong> account su <strong>${followingCount}</strong> che segui non ti seguono<br>
              (<strong>${notFollowingPercentage}%</strong> dei tuoi seguiti)
            </div>
          </div>
        </div>
        
        <!-- Lista degli account che non seguono -->
        ${notFollowingBack.length > 0 ? `
          <div style="background: white; border-radius: 12px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <div>
                <div style="font-size: 1.3em; font-weight: bold; color: #262626;">👥 Account che non ti seguono</div>
                <div style="color: #666; margin-top: 5px; font-size: 0.9em;">Clicca "Vedi" per aprire il profilo su Instagram</div>
              </div>
              <div style="background: #ff4444; color: white; padding: 6px 16px; border-radius: 20px; font-weight: bold; font-size: 0.95em;">
                ${notFollowingBack.length} account
              </div>
            </div>
            
            ${hasMore ? `
              <div style="background: #fff3cd; padding: 12px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #ffc107; font-size: 0.9em;">
                ⚠️ Per motivi di performance, mostrati i primi 200 account su ${notFollowingBack.length} totali
              </div>
            ` : ''}
            
            <div style="max-height: 500px; overflow-y: auto; border: 1px solid #ddd; border-radius: 8px;">
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${listItems}
              </ul>
            </div>
            
            ${hasMore ? `
              <div style="text-align: center; margin-top: 15px; padding: 10px; color: #666; font-size: 0.9em;">
                ... e altri ${notFollowingBack.length - 200} account non mostrati
              </div>
            ` : ''}
          </div>
        ` : `
          <div style="text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
            <div style="font-size: 1.6em; font-weight: bold; margin-bottom: 10px; color: #262626;">Fantastico!</div>
            <div style="color: #666; margin-bottom: 20px; line-height: 1.5;">
              Tutti gli account che segui ti seguono a loro volta!<br>
              Ottimo rapporto follower/seguaci!
            </div>
            <div style="background: #f0f8ff; padding: 15px; border-radius: 10px; display: inline-block; border-left: 4px solid #0095f6;">
              <div style="font-weight: bold; color: #0095f6; margin-bottom: 5px;">Bilancio follower</div>
              <div style="font-size: 1.2em;">
                <span style="color: #0095f6;">${followingCount}</span> seguiti → 
                <span style="color: #00a046;">${followersCount}</span> follower
              </div>
            </div>
          </div>
        `}
        
        <!-- Informazioni -->
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 0.9em; color: #666;">
          <div style="font-weight: bold; margin-bottom: 8px; color: #262626;">ℹ️ Informazioni tecniche:</div>
          <div style="line-height: 1.5;">
            • I dati sono estratti direttamente dai file JSON di Instagram<br>
            • Following: username estratti dal campo "title"<br>
            • Followers: username estratti dal campo "value" in "string_list_data"<br>
            • L'analisi viene eseguita completamente nel tuo browser, nessun dato viene inviato a server esterni
          </div>
        </div>
      </div>
    `;
  }

  // ========== INIZIALIZZAZIONE ==========
  loadJSZip().then(() => {
    const results = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');
    
    statusPill.textContent = '✅ Pronto';
    statusPill.className = 'pill success';
    
    results.innerHTML = `
      <div style="text-align: center; padding: 40px;">
        <div style="font-size: 4em; margin-bottom: 20px;">📊</div>
        <div style="font-size: 1.6em; font-weight: bold; margin-bottom: 10px; color: #262626;">Analizzatore Instagram</div>
        <div style="color: #666; margin-bottom: 25px; line-height: 1.5;">
          Scopri chi non ti segue su Instagram<br>
          Analizzando i tuoi dati scaricati dalla piattaforma
        </div>
        
        <div style="max-width: 600px; margin: 0 auto; padding: 25px; background: #f8f9fa; border-radius: 12px; text-align: left; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <div style="font-weight: bold; margin-bottom: 15px; color: #262626; font-size: 1.1em;">📥 Come ottenere i dati da Instagram:</div>
          <ol style="margin: 0; padding-left: 20px; font-size: 0.95em; line-height: 1.6;">
            <li style="margin-bottom: 10px;">Vai su <strong>Instagram Web</strong> (versione desktop)</li>
            <li style="margin-bottom: 10px;">Clicca sul tuo profilo → <strong>Impostazioni</strong> → <strong>Privacy e sicurezza</strong> → <strong>Dati personali</strong></li>
            <li style="margin-bottom: 10px;">Scarica dati → Seleziona <strong>"Seguaci e seguendo"</strong></li>
            <li>Riceverai un'email con il link per scaricare il file ZIP</li>
          </ol>
        </div>
        
        <div style="margin-top: 30px; padding: 15px; background: #e8f4ff; border-radius: 8px; display: inline-block; border-left: 4px solid #0095f6;">
          <div style="font-weight: bold; color: #0095f6;">💡 Importante:</div>
          <div style="font-size: 0.9em; color: #555; margin-top: 5px;">
            L'analisi si basa sui dati scaricati da Instagram.<br>
            I conteggi potrebbero differire leggermente dall'app mobile.
          </div>
        </div>
      </div>
    `;
    
    // Gestione input file
    const zipInput = document.getElementById('zipfile');
    const dropzone = document.getElementById('dropzone');
    const resetBtn = document.getElementById('resetBtn');
    
    if (zipInput) {
      zipInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else {
          alert('Per favore, seleziona un file ZIP valido scaricato da Instagram');
        }
      });
    }
    
    if (dropzone) {
      dropzone.addEventListener('click', () => {
        if (zipInput) zipInput.click();
      });
      
      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '#f0f8ff';
          dropzone.style.borderColor = '#0095f6';
          dropzone.style.transform = 'scale(1.02)';
        });
      });
      
      ['dragleave', 'drop'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '';
          dropzone.style.borderColor = '';
          dropzone.style.transform = '';
        });
      });
      
      dropzone.addEventListener('drop', e => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else {
          alert('Per favore, rilascia un file ZIP valido scaricato da Instagram');
        }
      });
    }
    
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (zipInput) zipInput.value = '';
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
        results.innerHTML = `
          <div style="text-align: center; padding: 40px;">
            <div style="font-size: 4em; margin-bottom: 20px;">🔄</div>
            <div style="font-size: 1.6em; font-weight: bold; margin-bottom: 10px; color: #262626;">Pronto per una nuova analisi</div>
            <div style="color: #666;">
              Carica un nuovo file ZIP di Instagram
            </div>
          </div>
        `;
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento JSZip:', error);
    results.innerHTML = `
      <div style="text-align: center; padding: 40px; background: #ffebee; border-radius: 12px;">
        <div style="font-size: 3em; margin-bottom: 20px;">❌</div>
        <div style="font-weight: bold; margin-bottom: 10px; color: #d32f2f;">Errore di caricamento</div>
        <div style="color: #666; line-height: 1.5;">
          Impossibile caricare le librerie necessarie.<br>
          Ricarica la pagina o controlla la connessione internet.
        </div>
      </div>
    `;
  });
});
