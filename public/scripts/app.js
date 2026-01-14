document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 30,
    // Pattern minimi per validazione di base
    VALID_USERNAME_PATTERN: /^[a-z0-9._]+$/i,
    NO_CONSECUTIVE_SPECIAL: /\.\.|__|_\.|\._/,
    NO_START_END_SPECIAL: /^[._]|[._]$/
  };

  // ========== FUNZIONI DI VALIDAZIONE BASE ==========
  function isValidInstagramFormat(username) {
    if (!username || typeof username !== 'string') return false;
    
    const cleanUsername = username.trim().toLowerCase();
    
    // Validazione lunghezza molto permissiva
    if (cleanUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) return false;
    
    // Solo caratteri validi
    if (!CONFIG.VALID_USERNAME_PATTERN.test(cleanUsername)) return false;
    
    // Non inizia/finisce con . o _
    if (CONFIG.NO_START_END_SPECIAL.test(cleanUsername)) return false;
    
    // Non ha due caratteri speciali consecutivi
    if (CONFIG.NO_CONSECUTIVE_SPECIAL.test(cleanUsername)) return false;
    
    return cleanUsername;
  }

  // ========== VERIFICA ESISTENZA PROFILO ==========
  async function checkProfileExists(username) {
    return new Promise((resolve) => {
      // Creiamo un iframe nascosto per verificare se il profilo esiste
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.style.position = 'absolute';
      iframe.style.left = '-9999px';
      
      // URL del profilo Instagram
      const profileUrl = `https://www.instagram.com/${username}/`;
      
      iframe.src = profileUrl;
      
      // Timeout per evitare attese infinite
      const timeoutId = setTimeout(() => {
        document.body.removeChild(iframe);
        resolve(false); // Timeout, consideriamo non esistente
      }, 10000); // 10 secondi timeout
      
      iframe.onload = function() {
        clearTimeout(timeoutId);
        
        try {
          // Verifica se il profilo esiste controllando elementi comuni
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          
          // Cerca indicatori di profilo esistente
          const indicators = [
            'meta[property="og:title"]',
            'title',
            'h1',
            'meta[property="al:ios:url"]',
            'link[rel="canonical"]'
          ];
          
          let hasValidProfile = false;
          
          for (const selector of indicators) {
            const elements = iframeDoc.querySelectorAll(selector);
            if (elements.length > 0) {
              // Controlla che non sia una pagina di errore
              const content = elements[0].textContent || 
                             elements[0].getAttribute('content') || 
                             elements[0].getAttribute('href') || '';
              
              if (!content.includes('404') && 
                  !content.includes('Not Found') && 
                  !content.includes('Page Not Found') &&
                  !content.toLowerCase().includes('error')) {
                hasValidProfile = true;
                break;
              }
            }
          }
          
          // Controllo aggiuntivo per pagine pubbliche
          if (!hasValidProfile) {
            // Cerca testo della pagina
            const pageText = iframeDoc.body.textContent || '';
            const errorIndicators = [
              'Sorry, this page',
              'Page not found',
              'This account doesn',
              'This profile could not be found',
              'The link you followed may be broken'
            ];
            
            const hasError = errorIndicators.some(error => 
              pageText.includes(error)
            );
            
            hasValidProfile = !hasError;
          }
          
          // Cleanup
          setTimeout(() => {
            document.body.removeChild(iframe);
          }, 100);
          
          resolve(hasValidProfile);
        } catch (error) {
          // In caso di errore (CORS), usiamo un metodo alternativo
          document.body.removeChild(iframe);
          checkProfileExistsAlt(username).then(resolve);
        }
      };
      
      iframe.onerror = function() {
        clearTimeout(timeoutId);
        document.body.removeChild(iframe);
        resolve(false);
      };
      
      document.body.appendChild(iframe);
    });
  }

  // Metodo alternativo usando fetch e proxy CORS
  async function checkProfileExistsAlt(username) {
    try {
      // Usiamo un proxy CORS per evitare problemi
      const proxyUrl = 'https://cors-anywhere.herokuapp.com/';
      const targetUrl = `https://www.instagram.com/${username}/`;
      
      const response = await fetch(proxyUrl + targetUrl, {
        method: 'HEAD',
        mode: 'cors',
        headers: {
          'Origin': window.location.origin
        }
      });
      
      // Instagram restituisce 200 anche per pagine non esistenti,
      // ma possiamo verificare i redirect
      const finalUrl = response.url;
      
      // Se il profilo non esiste, Instagram potrebbe reindirizzare
      return !finalUrl.includes('accounts/login') && 
             !finalUrl.includes('explore') &&
             response.status !== 404;
    } catch (error) {
      // Fallback: controllo più semplice
      return checkProfileExistsSimple(username);
    }
  }

  // Metodo semplice usando un'immagine del profilo
  async function checkProfileExistsSimple(username) {
    return new Promise((resolve) => {
      const img = new Image();
      
      // URL dell'immagine del profilo (Instagram usa questo pattern)
      const profilePicUrl = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
      
      img.onload = function() {
        resolve(true);
      };
      
      img.onerror = function() {
        // Prova alternativa
        const img2 = new Image();
        img2.src = `https://instagram.com/${username}/profilepic`;
        
        img2.onload = function() {
          resolve(true);
        };
        
        img2.onerror = function() {
          resolve(false);
        };
      };
      
      // Timeout
      setTimeout(() => {
        img.src = '';
        resolve(false);
      }, 5000);
      
      img.src = profilePicUrl;
    });
  }

  // ========== ESTRAZIONE USERNAME ==========
  function extractUsername(raw) {
    if (!raw) return null;
    
    const rawStr = String(raw).trim();
    let extracted = null;
    
    // Pattern molto permissivi per estrarre qualsiasi possibile username
    const patterns = [
      /instagram\.com\/([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/([a-z0-9._]+)/i,
      /@([a-z0-9._]+)/i,
      /"username"\s*:\s*"([^"]+)"/i,
      /"value"\s*:\s*"([^"]+)"/i,
      /"([a-z0-9._]+)"/i,
      /([a-z0-9._]+)/i
    ];
    
    for (const pattern of patterns) {
      const match = rawStr.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].toLowerCase();
        // Validazione molto permissiva
        if (candidate.length >= CONFIG.MIN_USERNAME_LENGTH && 
            candidate.length <= CONFIG.MAX_USERNAME_LENGTH &&
            /^[a-z0-9._]+$/i.test(candidate)) {
          extracted = candidate;
          break;
        }
      }
    }
    
    return extracted;
  }

  // ========== ANALISI FILE JSON ==========
  function analyzeJsonData(jsonContent, isFollowingFile = false) {
    const extractedUsernames = new Set();
    
    try {
      const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      
      // Funzione ricorsiva per cercare in tutto l'oggetto
      function traverse(obj, depth = 0) {
        if (depth > 20) return; // Limite di sicurezza
        
        if (!obj || typeof obj !== 'object') return;
        
        // Se è un array, itera su ogni elemento
        if (Array.isArray(obj)) {
          for (const item of obj) {
            traverse(item, depth + 1);
          }
          return;
        }
        
        // Se è un oggetto, cerca username in tutti i campi
        for (const [key, value] of Object.entries(obj)) {
          // Se il valore è una stringa, prova a estrarre username
          if (typeof value === 'string') {
            const username = extractUsername(value);
            if (username) {
              extractedUsernames.add(username);
            }
          } 
          // Se il valore è un oggetto o array, continua la ricerca
          else if (typeof value === 'object' && value !== null) {
            traverse(value, depth + 1);
          }
        }
        
        // Cerca in strutture specifiche di Instagram
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
        <div style="font-size: 2em; margin-bottom: 10px;">📂</div>
        <div>Caricamento file ZIP...</div>
      </div>
    `;
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      
      let followingFile = null;
      const followerFiles = [];
      
      // Cerca i file nel ZIP
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
      if (followerFiles.length === 0) throw new Error('Nessun file "followers" trovato');
      
      // Leggi e analizza i file
      const followingContent = await followingFile.async('string');
      const followingUsernamesRaw = analyzeJsonData(followingContent, true);
      
      results.innerHTML = `
        <div class="loading">
          <div style="font-size: 2em; margin-bottom: 10px;">🔍</div>
          <div>Analisi dei profili che segui...</div>
          <div style="font-size: 0.9em; color: #666; margin-top: 10px;">
            Trovati ${followingUsernamesRaw.length} possibili profili<br>
            Verifica esistenza in corso...
          </div>
        </div>
      `;
      
      // Verifica esistenza per i profili seguiti
      const validFollowingUsernames = [];
      let checked = 0;
      
      for (const username of followingUsernamesRaw) {
        const exists = await checkProfileExists(username);
        if (exists) {
          validFollowingUsernames.push(username);
        }
        
        checked++;
        // Aggiorna progresso ogni 10 profili
        if (checked % 10 === 0) {
          results.innerHTML = `
            <div class="loading">
              <div style="font-size: 2em; margin-bottom: 10px;">🔍</div>
              <div>Verifica profili che segui...</div>
              <div style="font-size: 0.9em; color: #666; margin-top: 10px;">
                ${checked}/${followingUsernamesRaw.length} profili verificati<br>
                ${validFollowingUsernames.length} profili validi trovati
              </div>
              <div style="width: 100%; background: #f0f0f0; height: 10px; margin-top: 10px; border-radius: 5px;">
                <div style="width: ${(checked/followingUsernamesRaw.length)*100}%; background: #405de6; height: 100%; border-radius: 5px;"></div>
              </div>
            </div>
          `;
        }
      }
      
      // Estrai follower
      results.innerHTML = `
        <div class="loading">
          <div style="font-size: 2em; margin-bottom: 10px;">👥</div>
          <div>Analisi dei tuoi follower...</div>
        </div>
      `;
      
      const allFollowers = new Set();
      
      for (const followerFile of followerFiles) {
        const followerContent = await followerFile.async('string');
        const followerUsernamesRaw = analyzeJsonData(followerContent);
        
        // Verifica esistenza per i follower
        for (const username of followerUsernamesRaw) {
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
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div class="error">
          <div style="font-size: 2em; margin-bottom: 10px;">⚠️</div>
          <strong>Errore durante l'analisi:</strong><br>
          ${error.message}<br><br>
          <div style="font-size: 0.9em;">
            Assicurati di caricare il file ZIP scaricato da Instagram<br>
            contenente "following.json" e "followers.json"
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
          <div style="display: inline-block; background: white; color: #405de6; padding: 10px 30px; border-radius: 25px; font-weight: bold; margin-top: 10px;">
            Bilancio: ${followingCount} seguono / ${followersCount} follower
          </div>
        </div>
      `;
      return;
    }
    
    const percentage = ((notFollowingBack.length / followingCount) * 100).toFixed(1);
    
    const listItems = notFollowingBack.slice(0, 100).map((username, index) => `
      <li style="padding: 15px; border-bottom: 1px solid #eee; transition: background 0.3s;" onmouseover="this.style.background='#f9f9f9'" onmouseout="this.style.background='white'">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 15px;">
            <div style="position: relative;">
              <div style="width: 50px; height: 50px; border-radius: 50%; background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 1.2em;">
                ${username.charAt(0).toUpperCase()}
              </div>
              <div style="position: absolute; top: -5px; right: -5px; background: #ff4757; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8em; font-weight: bold;">
                ${index + 1}
              </div>
            </div>
            <div>
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 5px;">
                <strong style="font-size: 1.1em;">@${username}</strong>
                <span style="background: #ff6b81; color: white; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; font-weight: bold;">
                  Non ti segue
                </span>
              </div>
              <div>
                <a href="https://instagram.com/${username}" target="_blank" style="color: #666; text-decoration: none; font-size: 0.9em;">
                  🔗 instagram.com/${username}
                </a>
              </div>
            </div>
          </div>
          <div>
            <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                    style="padding: 10px 20px; background: linear-gradient(45deg, #405de6, #833ab4); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; transition: transform 0.3s;"
                    onmouseover="this.style.transform='scale(1.05)'"
                    onmouseout="this.style.transform='scale(1)'">
              👁️ Vedi
            </button>
          </div>
        </div>
      </li>
    `).join('');
    
    const warning = notFollowingBack.length > 100 ? 
      `<div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #ffc107;">
        ⚠️ Mostrati i primi 100 profili su ${notFollowingBack.length} totali
      </div>` : '';
    
    results.innerHTML = `
      <div>
        <!-- Statistiche -->
        <div style="background: white; border-radius: 15px; padding: 25px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 25px;">
          <div style="font-size: 1.3em; font-weight: bold; margin-bottom: 20px; color: #333;">
            📊 Statistiche dell'Analisi
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px;">
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #405de6; margin-bottom: 5px;">${followingCount}</div>
              <div style="color: #666;">Profili che segui</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #00b894; margin-bottom: 5px;">${followersCount}</div>
              <div style="color: #666;">Ti seguono</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #ff4757; margin-bottom: 5px;">${notFollowingBack.length}</div>
              <div style="color: #666;">Non ti seguono</div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <div style="font-size: 2.5em; font-weight: bold; color: #ffa502; margin-bottom: 5px;">${percentage}%</div>
              <div style="color: #666;">Percentuale</div>
            </div>
          </div>
          
          <div style="background: #f1f2f6; padding: 15px; border-radius: 10px; font-size: 0.95em; color: #666;">
            ✅ <strong>Verifica completata:</strong> Tutti i profili sono stati verificati visitando il loro link Instagram.
            Solo i profili esistenti sono stati considerati nell'analisi.
          </div>
        </div>
        
        <!-- Lista profili -->
        <div style="background: white; border-radius: 15px; padding: 25px; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <div>
              <div style="font-size: 1.3em; font-weight: bold; color: #333;">👥 Profili che non ti seguono</div>
              <div style="color: #666; margin-top: 5px;">Clicca "Vedi" per visitare il profilo</div>
            </div>
            <div style="background: linear-gradient(45deg, #ff4757, #ff6b81); color: white; padding: 8px 20px; border-radius: 20px; font-weight: bold;">
              ${notFollowingBack.length} profili
            </div>
          </div>
          
          ${warning}
          
          <div style="max-height: 500px; overflow-y: auto; border: 1px solid #eee; border-radius: 10px;">
            <ul style="list-style: none; padding: 0; margin: 0;">
              ${listItems}
            </ul>
          </div>
          
          ${notFollowingBack.length > 100 ? `
            <div style="text-align: center; margin-top: 20px; color: #666; font-size: 0.9em;">
              ... e altri ${notFollowingBack.length - 100} profili
            </div>
          ` : ''}
        </div>
        
        <!-- Note -->
        <div style="margin-top: 20px; padding: 20px; background: #e8f4f8; border-radius: 10px; border-left: 4px solid #2d98da;">
          <div style="font-weight: bold; margin-bottom: 10px; color: #2d98da;">💡 Informazioni importanti:</div>
          <div style="font-size: 0.9em; color: #555; line-height: 1.5;">
            1. L'analisi verifica l'esistenza di ogni profilo visitando il suo link Instagram<br>
            2. Solo i profili che esistono realmente sono stati considerati<br>
            3. I profili privati che ti hanno bloccato potrebbero non essere rilevati come "follower"<br>
            4. L'analisi potrebbe richiedere tempo a causa delle verifiche individuali
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
        <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">Analizzatore Instagram</div>
        <div style="color: #666; margin-bottom: 30px; max-width: 500px; margin: 0 auto 30px;">
          Carica il file ZIP scaricato da Instagram per scoprire<br>
          <strong>chi non ti segue</strong>
        </div>
        
        <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
          <div style="font-weight: bold; margin-bottom: 10px;">📥 Come ottenere il file ZIP:</div>
          <div style="text-align: left; display: inline-block;">
            1. Vai su Instagram Web<br>
            2. Impostazioni → Privacy e sicurezza → Dati personali<br>
            3. Scarica dati → Seguaci e seguendo<br>
            4. Aspetta l'email e scarica il ZIP
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
        if (file && file.name.endsWith('.zip')) {
          processZipFile(file);
        } else {
          alert('Per favore, seleziona un file ZIP valido scaricato da Instagram');
        }
      });
    }
    
    if (dropzone) {
      dropzone.addEventListener('click', () => {
        zipInput.click();
      });
      
      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '#f0f8ff';
          dropzone.style.borderColor = '#405de6';
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
        if (file && file.name.endsWith('.zip')) {
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
          <div style="text-align: center; padding: 40px;">
            <div style="font-size: 4em; margin-bottom: 20px;">📊</div>
            <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 10px;">Analizzatore Instagram</div>
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
      <div style="text-align: center; padding: 40px; background: #ffebee; border-radius: 10px;">
        <div style="font-size: 3em; margin-bottom: 20px;">❌</div>
        <div style="font-weight: bold; margin-bottom: 10px;">Errore di caricamento</div>
        <div style="color: #666;">
          Impossibile caricare la libreria necessaria.<br>
          Ricarica la pagina o controlla la connessione.
        </div>
      </div>
    `;
  });
});
