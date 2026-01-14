document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50
  };

  // ========== FUNZIONI DI ESTRAZIONE ==========
  function extractUsername(value) {
    if (!value) return null;
    
    const strValue = String(value).trim().toLowerCase();
    
    // Pattern per estrarre username
    const patterns = [
      /instagram\.com\/([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/([a-z0-9._]+)/i,
      /@([a-z0-9._]+)/i,
      /^([a-z0-9._]+)$/i
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

  function extractUsernamesFromJson(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      // Funzione ricorsiva per cercare nei dati
      function traverse(obj, depth = 0) {
        if (depth > 5) return;
        if (!obj || typeof obj !== 'object') return;
        
        // Se è un array, cerca in ogni elemento
        if (Array.isArray(obj)) {
          for (const item of obj) {
            traverse(item, depth + 1);
          }
          return;
        }
        
        // Cerca username nei campi stringa
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === 'string') {
            const username = extractUsername(value);
            if (username) {
              usernames.add(username);
            }
          } else if (typeof value === 'object' && value !== null) {
            traverse(value, depth + 1);
          }
        }
        
        // Cerca in strutture specifiche di Instagram
        if (obj.string_list_data && Array.isArray(obj.string_list_data)) {
          for (const item of obj.string_list_data) {
            if (item.value) {
              const username = extractUsername(item.value);
              if (username) {
                usernames.add(username);
              }
            }
          }
        }
      }
      
      traverse(data);
      
    } catch (error) {
      console.error('Errore analisi JSON:', error);
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
          Estrazione dei dati dal file ZIP
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
          
          if (lowerPath.includes('following') && lowerPath.endsWith('.json')) {
            followingFile = entry;
          }
          
          if ((lowerPath.includes('follower') || lowerPath.includes('followers')) && 
              lowerPath.endsWith('.json')) {
            followerFiles.push(entry);
          }
        }
      });
      
      if (!followingFile) throw new Error('File "following.json" non trovato');
      if (followerFiles.length === 0) throw new Error('Nessun file "follower" trovato');
      
      // Leggi i file
      const followingContent = await followingFile.async('string');
      const followingUsernames = extractUsernamesFromJson(followingContent);
      
      // Leggi tutti i file follower
      const allFollowers = new Set();
      for (const followerFile of followerFiles) {
        const followerContent = await followerFile.async('string');
        const followerUsernames = extractUsernamesFromJson(followerContent);
        followerUsernames.forEach(u => allFollowers.add(u));
      }
      
      const followersArray = Array.from(allFollowers);
      
      // Trova chi non segue
      const followersSet = new Set(followersArray);
      const notFollowingBack = followingUsernames.filter(u => !followersSet.has(u));
      
      // Mostra risultati
      displayResults(notFollowingBack, followingUsernames.length, followersArray.length);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div style="text-align: center; padding: 30px; background: #ffebee; border-radius: 10px;">
          <div style="font-size: 3em; margin-bottom: 10px;">⚠️</div>
          <div style="font-weight: bold; margin-bottom: 10px;">Errore</div>
          <div style="color: #666; margin-bottom: 15px;">${error.message}</div>
          <div style="font-size: 0.9em; color: #999;">
            Assicurati di caricare il file ZIP scaricato da Instagram<br>
            che contiene i file "following.json" e "followers.json"
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
    
    // Prepara la lista
    const listItems = notFollowingBack.map(username => `
      <li style="padding: 15px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 40px; height: 40px; border-radius: 50%; background: #f0f0f0; 
                      display: flex; align-items: center; justify-content: center; font-weight: bold;">
            ${username.charAt(0).toUpperCase()}
          </div>
          <div>
            <div style="font-weight: bold; color: #333;">@${username}</div>
            <a href="https://instagram.com/${username}" target="_blank" 
               style="color: #666; text-decoration: none; font-size: 0.85em;">
              instagram.com/${username}
            </a>
          </div>
        </div>
        <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                style="padding: 6px 15px; background: #0095f6; color: white; border: none; 
                       border-radius: 4px; cursor: pointer; font-size: 0.9em;">
          Vedi profilo
        </button>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto;">
        <!-- Statistiche -->
        <div style="background: white; border-radius: 10px; padding: 25px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="font-size: 1.4em; font-weight: bold; margin-bottom: 20px; text-align: center;">
            📊 Risultati Analisi Instagram
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 25px;">
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #0095f6; margin-bottom: 5px;">${followingCount}</div>
              <div style="color: #666; font-size: 0.9em;">Account che segui</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #00a046; margin-bottom: 5px;">${followersCount}</div>
              <div style="color: #666; font-size: 0.9em;">Account che ti seguono</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #ff4444; margin-bottom: 5px;">${notFollowingBack.length}</div>
              <div style="color: #666; font-size: 0.9em;">Non ti seguono</div>
            </div>
          </div>
          
          <div style="background: #e8f4ff; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-weight: bold; margin-bottom: 5px;">🔍 Dettagli</div>
            <div style="font-size: 0.95em; color: #555;">
              <strong>${notFollowingBack.length}</strong> account su <strong>${followingCount}</strong> che segui non ti seguono<br>
              (<strong>${notFollowingPercentage}%</strong> dei tuoi seguiti)
            </div>
          </div>
        </div>
        
        <!-- Lista degli account che non seguono -->
        ${notFollowingBack.length > 0 ? `
          <div style="background: white; border-radius: 10px; padding: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <div>
                <div style="font-size: 1.2em; font-weight: bold; color: #333;">👥 Account che non ti seguono</div>
                <div style="color: #666; margin-top: 5px;">Clicca "Vedi profilo" per aprire su Instagram</div>
              </div>
              <div style="background: #ff4444; color: white; padding: 5px 15px; border-radius: 20px; font-weight: bold;">
                ${notFollowingBack.length} account
              </div>
            </div>
            
            <div style="max-height: 400px; overflow-y: auto; border: 1px solid #eee; border-radius: 8px;">
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${listItems}
              </ul>
            </div>
            
            ${notFollowingBack.length > 50 ? `
              <div style="text-align: center; margin-top: 15px; padding: 10px; background: #fff3cd; border-radius: 6px; font-size: 0.9em;">
                ⚠️ Mostrati ${Math.min(notFollowingBack.length, 50)} account su ${notFollowingBack.length} totali
              </div>
            ` : ''}
          </div>
        ` : `
          <div style="text-align: center; padding: 40px; background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
            <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">Perfetto!</div>
            <div style="color: #666; margin-bottom: 20px;">
              Tutti gli account che segui ti seguono a loro volta!<br>
              Ottimo rapporto follower/seguaci!
            </div>
            <div style="background: #e8f4ff; padding: 15px; border-radius: 8px; display: inline-block;">
              <strong>${followingCount}</strong> seguiti → <strong>${followersCount}</strong> follower
            </div>
          </div>
        `}
        
        <!-- Informazioni -->
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 0.9em; color: #666;">
          <div style="font-weight: bold; margin-bottom: 5px;">ℹ️ Informazioni:</div>
          <div>I dati sono estratti dal file ZIP scaricato da Instagram. L'analisi viene eseguita completamente nel tuo browser.</div>
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
        <div style="font-size: 4em; margin-bottom: 20px;">📁</div>
        <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">Analizzatore Instagram</div>
        <div style="color: #666; margin-bottom: 30px;">
          Carica il file ZIP di Instagram per scoprire<br>
          <strong>chi non ti segue</strong>
        </div>
        
        <div style="max-width: 500px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 10px; text-align: left;">
          <div style="font-weight: bold; margin-bottom: 10px;">📥 Come ottenere il file ZIP:</div>
          <ol style="margin: 0; padding-left: 20px; font-size: 0.9em;">
            <li style="margin-bottom: 8px;">Vai su Instagram Web (desktop)</li>
            <li style="margin-bottom: 8px;">Impostazioni → Privacy e sicurezza → Dati personali</li>
            <li style="margin-bottom: 8px;">Scarica dati → Seguaci e seguendo</li>
            <li>Riceverai un'email con il link per scaricare il file ZIP</li>
          </ol>
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
          alert('Per favore, seleziona un file ZIP valido scaricato da Instagram');
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
          alert('Per favore, rilascia un file ZIP valido scaricato da Instagram');
        }
      });
    }
    
    // Gestione reset
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (zipInput) zipInput.value = '';
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
        results.innerHTML = `
          <div style="text-align: center; padding: 40px;">
            <div style="font-size: 4em; margin-bottom: 20px;">📊</div>
            <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">Pronto per una nuova analisi</div>
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
      <div style="text-align: center; padding: 40px;">
        <div style="font-size: 3em; margin-bottom: 20px;">❌</div>
        <div style="font-weight: bold; margin-bottom: 10px;">Errore di caricamento</div>
        <div style="color: #666;">
          Impossibile caricare le librerie necessarie.<br>
          Ricarica la pagina o controlla la connessione internet.
        </div>
      </div>
    `;
  });
});
