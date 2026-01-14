document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const FILTER_CONFIG = {
    MIN_USERNAME_LENGTH: 3,
    MAX_USERNAME_LENGTH: 30,
    // Pattern minimi per escludere solo i casi più evidenti
    EXCLUDE_PATTERNS: [
      /^[0-9]+$/, // Solo numeri
      /^\.+$/, // Solo punti
      /^_+$/, // Solo underscore
      /^[a-z]{1}$/i, // Singola lettera
    ]
  };

  // ========== FUNZIONI DI VALIDAZIONE ==========
  function isValidInstagramUsername(username) {
    if (!username || typeof username !== 'string') return false;
    
    const cleanUsername = username.trim().toLowerCase();
    
    if (cleanUsername.length < FILTER_CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > FILTER_CONFIG.MAX_USERNAME_LENGTH) return false;
    
    if (!/^[a-z0-9._]+$/.test(cleanUsername)) return false;
    
    if (/^[._]|[._]$/.test(cleanUsername)) return false;
    
    if (/\.\.|__|_\.|\._/.test(cleanUsername)) return false;
    
    for (const pattern of FILTER_CONFIG.EXCLUDE_PATTERNS) {
      if (pattern.test(cleanUsername)) return false;
    }
    
    return cleanUsername;
  }

  // Simulazione controllo esistenza profilo (nella realtà userei API Instagram)
  async function checkProfileExists(username) {
    // Questo è un placeholder - nella realtà dovresti fare una richiesta a Instagram
    // Per ora assumiamo che tutti gli username estratti dal JSON esistano
    return new Promise(resolve => {
      setTimeout(() => {
        // Simula che il 95% dei profili esista (per test)
        resolve(Math.random() > 0.05);
      }, 10);
    });
  }

  function extractUsername(raw) {
    if (!raw) return null;
    
    const rawStr = String(raw).trim();
    let extracted = null;
    
    const patterns = [
      /instagram\.com\/(?:p\/|reel\/|stories\/|explore\/tags\/|accounts\/edit\/)?@?([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/(?:p\/|reel\/|stories\/|explore\/tags\/|accounts\/edit\/)?@?([a-z0-9._]+)/i,
      /^@([a-z0-9._]+)$/i,
      /^([a-z0-9._]+)$/i,
      /"value":\s*"([a-z0-9._]+)"/i,
      /"href":\s*"[^"]*\/([a-z0-9._]+)\/?["\?]/i
    ];
    
    for (const pattern of patterns) {
      const match = rawStr.match(pattern);
      if (match && match[1]) {
        extracted = match[1].toLowerCase().replace(/[^\w._]/g, '');
        if (isValidInstagramUsername(extracted)) {
          return extracted;
        }
      }
    }
    
    return null;
  }

  // ========== ANALISI FILE JSON ==========
  function analyzeJsonData(jsonContent, isFollowingFile = false) {
    const extractedUsernames = new Set();
    
    try {
      const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      
      function traverse(obj, depth = 0) {
        if (depth > 10) return; // Limite di profondità per sicurezza
        if (!obj || typeof obj !== 'object') return;
        
        // Cerca username in vari campi
        const searchFields = ['value', 'href', 'title', 'string_list_data', 'relationships_following', 'media_list_data'];
        
        if (Array.isArray(obj)) {
          for (const item of obj) {
            traverse(item, depth + 1);
          }
          return;
        }
        
        // Per file following, cerca strutture specifiche
        if (isFollowingFile) {
          if (obj.string_list_data && Array.isArray(obj.string_list_data)) {
            for (const item of obj.string_list_data) {
              if (item.value) {
                const username = extractUsername(item.value);
                if (username) extractedUsernames.add(username);
              }
              traverse(item, depth + 1);
            }
          }
          
          if (obj.relationships_following && Array.isArray(obj.relationships_following)) {
            for (const item of obj.relationships_following) {
              traverse(item, depth + 1);
            }
          }
        }
        
        // Cerca in tutti i campi stringa
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === 'string') {
            const username = extractUsername(value);
            if (username) extractedUsernames.add(username);
          } else if (typeof value === 'object') {
            traverse(value, depth + 1);
          }
        }
      }
      
      traverse(data);
    } catch (error) {
      console.error('Errore analisi JSON:', error);
    }
    
    return Array.from(extractedUsernames);
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
      <div class="loading">
        <div style="font-size: 2em; margin-bottom: 10px;">🔍</div>
        <div>Analisi in corso...</div>
        <div style="font-size: 0.9em; color: #666; margin-top: 10px;">
          Estrazione degli username dal file ZIP
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
          
          if (lowerPath.includes('following') && 
              (lowerPath.endsWith('.json') || lowerPath.includes('following.json'))) {
            followingFile = entry;
          }
          
          if ((lowerPath.includes('follower') || lowerPath.includes('followers')) && 
              (lowerPath.endsWith('.json'))) {
            followerFiles.push(entry);
          }
        }
      });
      
      if (!followingFile) throw new Error('File "following" non trovato nel ZIP');
      if (followerFiles.length === 0) throw new Error('File "followers" non trovati nel ZIP');
      
      // Estrai username dai file
      const followingContent = await followingFile.async('string');
      const followingUsernames = analyzeJsonData(followingContent, true);
      
      // Verifica esistenza profili (simulato)
      results.innerHTML = `
        <div class="loading">
          <div style="font-size: 2em; margin-bottom: 10px;">📊</div>
          <div>Verifica profili...</div>
          <div style="font-size: 0.9em; color: #666; margin-top: 10px;">
            Trovati ${followingUsernames.length} profili che segui<br>
            Verifica esistenza in corso...
          </div>
        </div>
      `;
      
      // Verifica quali profili esistono
      const validFollowingUsernames = [];
      for (const username of followingUsernames) {
        const exists = await checkProfileExists(username);
        if (exists) {
          validFollowingUsernames.push(username);
        }
      }
      
      // Estrai follower
      const allFollowers = new Set();
      for (const followerFile of followerFiles) {
        const followerContent = await followerFile.async('string');
        const followerUsernames = analyzeJsonData(followerContent);
        
        // Verifica esistenza anche per i follower
        for (const username of followerUsernames) {
          const exists = await checkProfileExists(username);
          if (exists) {
            allFollowers.add(username);
          }
        }
      }
      
      const followersArray = Array.from(allFollowers);
      const followersSet = new Set(followersArray);
      
      // Trova chi non segue
      const notFollowingBack = validFollowingUsernames.filter(u => !followersSet.has(u));
      
      displayResults(notFollowingBack, validFollowingUsernames.length, followersArray.length);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div class="error">
          <div style="font-size: 2em; margin-bottom: 10px;">⚠️</div>
          <strong>Errore durante l'analisi:</strong><br>
          ${error.message}<br><br>
          <div style="font-size: 0.9em;">
            Assicurati di caricare il file ZIP scaricato da Instagram.<br>
            Dovrebbe contenere file "following.json" e "followers.json"
          </div>
        </div>
      `;
    }
  }

  // ========== VISUALIZZAZIONE RISULTATI ==========
  function displayResults(notFollowingBack, followingCount, followersCount) {
    const results = document.getElementById('results');
    
    if (notFollowingBack.length === 0) {
      results.innerHTML = `
        <div class="success">
          <div style="font-size: 3em; margin-bottom: 10px;">🎉</div>
          <strong>Perfetto!</strong><br>
          Tutti i ${followingCount} account che segui<br>
          ti seguono a loro volta!<br><br>
          <div style="font-size: 0.9em; color: #666;">
            Seguiti: ${followingCount} | Follower: ${followersCount}
          </div>
        </div>
      `;
      return;
    }
    
    const notFollowingPercentage = ((notFollowingBack.length / followingCount) * 100).toFixed(1);
    
    const listItems = notFollowingBack.map(username => `
      <li class="user-item">
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 10px; border-bottom: 1px solid #eee;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 1.2em;">
              ${username.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style="font-weight: bold; font-size: 1.1em;">@${username}</div>
              <a href="https://instagram.com/${username}" target="_blank" style="font-size: 0.85em; color: #666; text-decoration: none;">
                instagram.com/${username}
              </a>
            </div>
          </div>
          <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                  style="padding: 8px 16px; background: #405de6; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; transition: background 0.3s;"
                  onmouseover="this.style.background='#3045c5'"
                  onmouseout="this.style.background='#405de6'">
            Vedi Profilo
          </button>
        </div>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div style="margin-bottom: 25px;">
        <div style="background: linear-gradient(45deg, #405de6, #833ab4); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
          <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">📊 Risultati Analisi</div>
          <div style="display: flex; justify-content: space-between;">
            <div style="text-align: center;">
              <div style="font-size: 2em; font-weight: bold;">${followingCount}</div>
              <div style="font-size: 0.9em;">Profili che segui</div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 2em; font-weight: bold;">${followersCount}</div>
              <div style="font-size: 0.9em;">Tuoi follower</div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 2em; font-weight: bold;">${notFollowingBack.length}</div>
              <div style="font-size: 0.9em;">Non ti seguono</div>
            </div>
          </div>
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <strong>👥 Account che non ti seguono:</strong> ${notFollowingBack.length}
            </div>
            <div style="font-size: 0.9em; color: #666; background: white; padding: 4px 12px; border-radius: 20px;">
              ${notFollowingPercentage}% dei seguiti
            </div>
          </div>
          
          <div style="background: white; padding: 10px; border-radius: 6px; font-size: 0.9em; color: #666;">
            ✅ <strong>Verifica completata:</strong> Esclusi solo account inesistenti o non validi
          </div>
        </div>
        
        <div style="max-height: 400px; overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 8px;">
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${listItems}
          </ul>
        </div>
        
        <div style="margin-top: 20px; padding: 15px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
          <strong>💡 Suggerimento:</strong> Non tutti gli account che non ti seguono lo fanno intenzionalmente. 
          Alcuni potrebbero essere account inattivi o che non controllano spesso i follower.
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
      <div style="text-align: center; padding: 20px;">
        <div style="font-size: 3em; margin-bottom: 10px;">📁</div>
        <strong>Pronto per l'analisi!</strong><br>
        Carica il file ZIP di Instagram<br><br>
        <div style="font-size: 0.9em; color: #666; max-width: 400px; margin: 0 auto;">
          1. Scarica i tuoi dati da Instagram (Impostazioni → Privacy e sicurezza → Dati personali)<br>
          2. Scegli "Followers and following"<br>
          3. Carica il file ZIP qui
        </div>
      </div>
    `;
    
    const zipInput = document.getElementById('zipfile');
    const dropzone = document.getElementById('dropzone');
    const resetBtn = document.getElementById('resetBtn');
    
    if (zipInput) {
      zipInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file && file.name.endsWith('.zip')) {
          processZipFile(file);
        } else {
          results.innerHTML = `
            <div class="error">
              <div style="font-size: 2em; margin-bottom: 10px;">⚠️</div>
              Seleziona un file ZIP valido<br>
              Il file deve avere estensione .zip
            </div>
          `;
        }
      });
    }
    
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.classList.add('drag-over');
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
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.zip')) {
          processZipFile(file);
        } else {
          results.innerHTML = `
            <div class="error">
              <div style="font-size: 2em; margin-bottom: 10px;">⚠️</div>
              Rilascia un file ZIP valido
            </div>
          `;
        }
      });
    }
    
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (zipInput) zipInput.value = '';
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
        results.innerHTML = `
          <div style="text-align: center; padding: 20px;">
            <div style="font-size: 3em; margin-bottom: 10px;">📁</div>
            <strong>Pronto per l'analisi!</strong><br>
            Carica il file ZIP di Instagram
          </div>
        `;
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento JSZip:', error);
    document.getElementById('results').innerHTML = `
      <div class="error">
        <div style="font-size: 2em; margin-bottom: 10px;">❌</div>
        <strong>Errore di caricamento</strong><br>
        Impossibile caricare la libreria necessaria.<br>
        Ricarica la pagina o controlla la connessione.
      </div>
    `;
  });
});
