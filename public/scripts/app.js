document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50
  };

  // ========== FUNZIONI DI VALIDAZIONE ==========
  function isValidInstagramFormat(username) {
    if (!username || typeof username !== 'string') return false;
    
    const cleanUsername = username.trim().toLowerCase();
    
    if (cleanUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) return false;
    
    return cleanUsername;
  }

  // ========== ESTRAZIONE USERNAME DAL JSON INSTAGRAM ==========
  function extractUsernameFromInstagramData(value) {
    if (!value) return null;
    
    const strValue = String(value).trim();
    
    // Pattern per estrarre username da stringhe Instagram
    const patterns = [
      // Da URL Instagram
      /instagram\.com\/([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/([a-z0-9._]+)/i,
      
      // Da @username
      /@([a-z0-9._]+)/i,
      
      // Da campo "value" nel JSON
      /"value":\s*"([^"]+)"/i,
      
      // Solo username (se è già pulito)
      /^([a-z0-9._]+)$/i
    ];
    
    for (const pattern of patterns) {
      const match = strValue.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].toLowerCase();
        if (candidate.length >= 1 && candidate.length <= 50) {
          return candidate;
        }
      }
    }
    
    return null;
  }

  // ========== ANALISI FILE JSON INSTAGRAM ==========
  function extractUsernamesFromInstagramJson(jsonData, isFollowing = false) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      // Funzione ricorsiva per cercare nei dati
      function traverse(obj, depth = 0) {
        if (depth > 10) return;
        if (!obj || typeof obj !== 'object') return;
        
        // Se è un array, cerca in ogni elemento
        if (Array.isArray(obj)) {
          for (const item of obj) {
            traverse(item, depth + 1);
          }
          return;
        }
        
        // Se l'oggetto ha una struttura specifica di Instagram
        if (obj.string_list_data && Array.isArray(obj.string_list_data)) {
          for (const item of obj.string_list_data) {
            if (item.value) {
              const username = extractUsernameFromInstagramData(item.value);
              if (username) {
                usernames.add(username);
              }
            }
          }
        }
        
        // Cerca in tutti i valori stringa
        for (const key in obj) {
          const value = obj[key];
          
          if (typeof value === 'string') {
            // Per following/followers, il campo "value" spesso contiene l'username
            if (key === 'value' || key === 'href' || key === 'title') {
              const username = extractUsernameFromInstagramData(value);
              if (username) {
                usernames.add(username);
              }
            }
            
            // Anche se non è un campo specifico, potrebbe contenere un username
            if (value.includes('instagram.com/') || value.startsWith('@')) {
              const username = extractUsernameFromInstagramData(value);
              if (username) {
                usernames.add(username);
              }
            }
          } else if (typeof value === 'object' && value !== null) {
            traverse(value, depth + 1);
          }
        }
      }
      
      traverse(data);
      
      // Cerca anche in strutture ad alto livello
      if (data.relationships_following && Array.isArray(data.relationships_following)) {
        for (const item of data.relationships_following) {
          traverse(item);
        }
      }
      
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
      <div class="loading">
        <div style="font-size: 2em; margin-bottom: 10px;">📂</div>
        <div>Analisi file ZIP in corso...</div>
        <div style="font-size: 0.9em; color: #666; margin-top: 10px;">
          Questo potrebbe richiedere alcuni secondi
        </div>
      </div>
    `;
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      
      // Cerca i file nel ZIP
      let followingFiles = [];
      let followerFiles = [];
      
      zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir) {
          const lowerPath = relativePath.toLowerCase();
          
          if (lowerPath.includes('following') && (lowerPath.endsWith('.json') || lowerPath.includes('.json'))) {
            followingFiles.push(zipEntry);
          }
          
          if ((lowerPath.includes('follower') || lowerPath.includes('followers')) && 
              (lowerPath.endsWith('.json') || lowerPath.includes('.json'))) {
            followerFiles.push(zipEntry);
          }
        }
      });
      
      if (followingFiles.length === 0) throw new Error('Nessun file "following" trovato nel ZIP');
      if (followerFiles.length === 0) throw new Error('Nessun file "follower" trovato nel ZIP');
      
      // Leggi e analizza i file following
      const allFollowing = new Set();
      for (const file of followingFiles) {
        const content = await file.async('string');
        const usernames = extractUsernamesFromInstagramJson(content, true);
        usernames.forEach(username => allFollowing.add(username));
      }
      
      // Leggi e analizza i file follower
      const allFollowers = new Set();
      for (const file of followerFiles) {
        const content = await file.async('string');
        const usernames = extractUsernamesFromInstagramJson(content, false);
        usernames.forEach(username => allFollowers.add(username));
      }
      
      const followingArray = Array.from(allFollowing);
      const followersArray = Array.from(allFollowers);
      
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
        <div class="error">
          <div style="font-size: 2em; margin-bottom: 10px;">⚠️</div>
          <strong>Errore durante l'analisi:</strong><br>
          ${error.message}<br><br>
          <div style="font-size: 0.9em;">
            Assicurati di caricare il file ZIP scaricato da Instagram.<br>
            Deve contenere file JSON con i dati dei follower e following.
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
        <div style="text-align: center; padding: 40px; background: linear-gradient(135deg, #405de6, #833ab4); color: white; border-radius: 15px;">
          <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
          <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">Fantastico!</div>
          <div style="font-size: 1.1em; margin-bottom: 20px;">
            Tutti i ${followingCount} account che segui<br>
            ti seguono a loro volta!
          </div>
          <div style="background: rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 20px; display: inline-block;">
            📊 ${followingCount} seguiti → ${followersCount} follower
          </div>
        </div>
      `;
      return;
    }
    
    const percentage = ((notFollowingBack.length / followingCount) * 100).toFixed(1);
    
    // Prepara la lista degli utenti (limitata ai primi 100 per performance)
    const usersToShow = notFollowingBack.slice(0, 100);
    const hasMore = notFollowingBack.length > 100;
    
    const listItems = usersToShow.map((username, index) => `
      <li style="padding: 12px; border-bottom: 1px solid #eee; transition: background 0.2s;" 
          onmouseover="this.style.background='#f9f9f9'" 
          onmouseout="this.style.background='white'">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); 
                    display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 1em;">
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
                  style="padding: 6px 15px; background: #405de6; color: white; border: none; border-radius: 6px; 
                         cursor: pointer; font-size: 0.9em; transition: background 0.2s;"
                  onmouseover="this.style.background='#3045c5'" 
                  onmouseout="this.style.background='#405de6'">
            Vedi
          </button>
        </div>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div>
        <!-- Statistiche -->
        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px;">
          <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 15px; color: #333;">
            📊 Risultati dell'analisi
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 15px;">
            <div style="text-align: center; padding: 15px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 1.8em; font-weight: bold; color: #405de6; margin-bottom: 5px;">${followingCount}</div>
              <div style="color: #666; font-size: 0.9em;">Seguiti</div>
            </div>
            
            <div style="text-align: center; padding: 15px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 1.8em; font-weight: bold; color: #00b894; margin-bottom: 5px;">${followersCount}</div>
              <div style="color: #666; font-size: 0.9em;">Follower</div>
            </div>
            
            <div style="text-align: center; padding: 15px; background: #f8f9fa; border-radius: 8px;">
              <div style="font-size: 1.8em; font-weight: bold; color: #ff4757; margin-bottom: 5px;">${notFollowingBack.length}</div>
              <div style="color: #666; font-size: 0.9em;">Non ti seguono</div>
            </div>
          </div>
          
          <div style="background: #e8f4f8; padding: 12px; border-radius: 8px; font-size: 0.9em; color: #2d98da; border-left: 4px solid #2d98da;">
            <strong>📝 Nota:</strong> I dati sono estratti direttamente dal file JSON di Instagram.
            ${percentage}% delle persone che segui non ti segue.
          </div>
        </div>
        
        <!-- Lista profili -->
        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <div>
              <div style="font-size: 1.2em; font-weight: bold; color: #333;">👥 Account che non ti seguono</div>
              <div style="color: #666; margin-top: 5px; font-size: 0.9em;">Clicca "Vedi" per aprire il profilo</div>
            </div>
            <div style="background: #ff4757; color: white; padding: 5px 15px; border-radius: 20px; font-weight: bold; font-size: 0.9em;">
              ${notFollowingBack.length} account
            </div>
          </div>
          
          ${hasMore ? `
            <div style="background: #fff3cd; padding: 10px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #ffc107; font-size: 0.9em;">
              ⚠️ Mostrati i primi 100 account su ${notFollowingBack.length} totali
            </div>
          ` : ''}
          
          <div style="max-height: 400px; overflow-y: auto; border: 1px solid #eee; border-radius: 8px;">
            <ul style="list-style: none; padding: 0; margin: 0;">
              ${listItems}
            </ul>
          </div>
          
          ${hasMore ? `
            <div style="text-align: center; margin-top: 15px; color: #666; font-size: 0.9em;">
              ... e altri ${notFollowingBack.length - 100} account
            </div>
          ` : ''}
        </div>
        
        <!-- Info -->
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 0.85em; color: #666;">
          <strong>ℹ️ Informazioni:</strong> Questo strumento analizza i dati scaricati da Instagram per mostrare 
          quali account che segui non ti seguono a loro volta. I dati vengono elaborati localmente nel tuo browser 
          e non vengono inviati a nessun server.
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
      <div style="text-align: center; padding: 30px;">
        <div style="font-size: 3em; margin-bottom: 15px;">📊</div>
        <div style="font-size: 1.3em; font-weight: bold; margin-bottom: 10px;">Analizzatore Instagram</div>
        <div style="color: #666; margin-bottom: 25px; max-width: 500px; margin: 0 auto 25px;">
          Scopri chi non ti segue su Instagram analizzando i tuoi dati
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: left; display: inline-block;">
          <div style="font-weight: bold; margin-bottom: 10px;">📥 Come ottenere i dati:</div>
          <div style="font-size: 0.9em;">
            1. Vai su Instagram Web (desktop)<br>
            2. Impostazioni → Privacy e sicurezza → Dati personali<br>
            3. Scarica dati → Seguaci e seguendo<br>
            4. Scarica il file ZIP e caricalo qui
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
        });
      });
      
      ['dragleave', 'drop'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '';
        });
      });
      
      dropzone.addEventListener('drop', e => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.name.toLowerCase().endsWith('.zip')) {
          processZipFile(file);
        } else {
          alert('Per favore, rilascia un file ZIP valido');
        }
      });
    }
    
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (zipInput) zipInput.value = '';
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
        results.innerHTML = `
          <div style="text-align: center; padding: 30px;">
            <div style="font-size: 3em; margin-bottom: 15px;">📊</div>
            <div style="font-size: 1.3em; font-weight: bold; margin-bottom: 10px;">Analizzatore Instagram</div>
            <div style="color: #666;">
              Pronto per una nuova analisi
            </div>
          </div>
        `;
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento JSZip:', error);
    results.innerHTML = `
      <div style="text-align: center; padding: 30px; background: #ffebee; border-radius: 10px;">
        <div style="font-size: 2.5em; margin-bottom: 15px;">❌</div>
        <div style="font-weight: bold; margin-bottom: 10px;">Errore di caricamento</div>
        <div style="color: #666; font-size: 0.9em;">
          Impossibile caricare la libreria necessaria.<br>
          Ricarica la pagina o controlla la connessione.
        </div>
      </div>
    `;
  });
});
