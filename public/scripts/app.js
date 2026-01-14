document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50
  };

  // ========== FUNZIONI DI ESTRAZIONE ==========
  function cleanInstagramUsername(username) {
    if (!username) return null;
    
    // Converti in stringa e pulisci
    const cleanUsername = String(username).trim().toLowerCase();
    
    // Rimuovi caratteri non validi per Instagram
    const validUsername = cleanUsername.replace(/[^a-z0-9._]/g, '');
    
    if (validUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        validUsername.length > CONFIG.MAX_USERNAME_LENGTH) return null;
    
    // Controlla formato Instagram base
    if (!/^[a-z0-9._]+$/.test(validUsername)) return null;
    
    return validUsername;
  }

  // ========== ANALISI FOLLOWING ==========
  function extractUsernamesFromFollowingJson(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      // Following.json ha questa struttura: {"relationships_following": [...]}
      if (data.relationships_following && Array.isArray(data.relationships_following)) {
        data.relationships_following.forEach(item => {
          // PRIMA PRIORITÀ: campo "title" (contiene l'username)
          if (item.title) {
            const username = cleanInstagramUsername(item.title);
            if (username) {
              usernames.add(username);
              return; // Usiamo il title come fonte principale
            }
          }
          
          // SECONDA PRIORITÀ: campo "href" in string_list_data
          if (item.string_list_data && Array.isArray(item.string_list_data)) {
            item.string_list_data.forEach(stringItem => {
              if (stringItem.href) {
                // Estrai username da URL come instagram.com/_u/username
                const href = stringItem.href.toLowerCase();
                const patterns = [
                  /instagram\.com\/_u\/([a-z0-9._]+)/i,
                  /instagram\.com\/([a-z0-9._]+)/i
                ];
                
                for (const pattern of patterns) {
                  const match = href.match(pattern);
                  if (match && match[1]) {
                    const username = cleanInstagramUsername(match[1]);
                    if (username) usernames.add(username);
                    break;
                  }
                }
              }
            });
          }
        });
      }
      
      console.log(`Following estratti: ${usernames.size}`);
      
    } catch (error) {
      console.error('Errore analisi following JSON:', error);
    }
    
    return Array.from(usernames);
  }

  // ========== ANALISI FOLLOWERS ==========
  function extractUsernamesFromFollowersJson(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      // Follower.json ha questa struttura: [ {...}, {...} ] (array di oggetti)
      if (Array.isArray(data)) {
        data.forEach(item => {
          // Cerca in string_list_data -> value (questo è il campo per followers)
          if (item.string_list_data && Array.isArray(item.string_list_data)) {
            item.string_list_data.forEach(stringItem => {
              // PRIORITÀ: campo "value" (contiene l'username)
              if (stringItem.value) {
                const username = cleanInstagramUsername(stringItem.value);
                if (username) {
                  usernames.add(username);
                  return;
                }
              }
              
              // Fallback: campo "href"
              if (stringItem.href) {
                const href = stringItem.href.toLowerCase();
                const patterns = [
                  /instagram\.com\/([a-z0-9._]+)/i,
                  /instagram\.com\/_u\/([a-z0-9._]+)/i
                ];
                
                for (const pattern of patterns) {
                  const match = href.match(pattern);
                  if (match && match[1]) {
                    const username = cleanInstagramUsername(match[1]);
                    if (username) usernames.add(username);
                    break;
                  }
                }
              }
            });
          }
        });
      }
      
      console.log(`Followers estratti: ${usernames.size}`);
      
    } catch (error) {
      console.error('Errore analisi followers JSON:', error);
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
      <div style="text-align: center; padding: 40px;">
        <div style="font-size: 3em; margin-bottom: 15px;">🔍</div>
        <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 10px;">Analisi in corso...</div>
        <div style="color: #666; font-size: 0.9em; line-height: 1.5;">
          Estrazione dei dati dal file ZIP<br>
          <span id="progressText">Caricamento file...</span>
        </div>
        <div style="width: 200px; height: 4px; background: #f0f0f0; margin: 20px auto; border-radius: 2px;">
          <div id="progressBar" style="width: 0%; height: 100%; background: #0095f6; border-radius: 2px; transition: width 0.3s;"></div>
        </div>
      </div>
    `;
    
    try {
      const progressText = document.getElementById('progressText');
      const progressBar = document.getElementById('progressBar');
      
      progressText.textContent = 'Lettura file ZIP...';
      progressBar.style.width = '25%';
      
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
      
      progressText.textContent = `File trovati: ${followingFile ? '1 following' : '0 following'}, ${followerFiles.length} followers`;
      progressBar.style.width = '40%';
      
      if (!followingFile) throw new Error('File "following.json" non trovato nel ZIP');
      if (followerFiles.length === 0) throw new Error('Nessun file "follower" trovato nel ZIP');
      
      // Leggi file following
      progressText.textContent = 'Analisi account che segui...';
      progressBar.style.width = '50%';
      
      const followingContent = await followingFile.async('string');
      const followingUsernames = extractUsernamesFromFollowingJson(followingContent);
      
      // Leggi tutti i file follower
      progressText.textContent = 'Analisi account che ti seguono...';
      progressBar.style.width = '70%';
      
      const allFollowers = new Set();
      for (let i = 0; i < followerFiles.length; i++) {
        const followerFile = followerFiles[i];
        const followerContent = await followerFile.async('string');
        const followerUsernames = extractUsernamesFromFollowersJson(followerContent);
        followerUsernames.forEach(u => allFollowers.add(u));
        
        // Aggiorna progresso
        const progress = 70 + (i / followerFiles.length * 20);
        progressBar.style.width = `${progress}%`;
      }
      
      const followersArray = Array.from(allFollowers);
      
      // Trova chi non segue
      progressText.textContent = 'Confronto account...';
      progressBar.style.width = '95%';
      
      const followersSet = new Set(followersArray);
      const notFollowingBack = followingUsernames.filter(u => !followersSet.has(u));
      
      // Mostra risultati
      displayResults(notFollowingBack, followingUsernames.length, followersArray.length);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
      progressBar.style.width = '100%';
      
    } catch (error) {
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div style="text-align: center; padding: 40px; background: #ffebee; border-radius: 12px;">
          <div style="font-size: 3em; margin-bottom: 20px;">⚠️</div>
          <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 15px; color: #d32f2f;">Errore nell'analisi</div>
          <div style="color: #666; margin-bottom: 20px; line-height: 1.5;">${error.message}</div>
          <div style="font-size: 0.9em; color: #999; background: rgba(0,0,0,0.05); padding: 15px; border-radius: 8px;">
            <strong>Struttura attesa dei file:</strong><br>
            • following.json: {"relationships_following": [...]} con campo "title"<br>
            • followers_*.json: array di oggetti con campo "value" in "string_list_data"
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
    const listItems = usersToShow.map((username, index) => `
      <li style="padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; transition: background 0.2s;"
          onmouseover="this.style.background='#f9f9f9'" onmouseout="this.style.background='white'">
        <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
          <div style="flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); 
                      display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 0.9em;">
            ${username.charAt(0).toUpperCase()}
          </div>
          <div style="min-width: 0; flex: 1;">
            <div style="font-weight: 600; color: #262626; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              @${username}
            </div>
            <a href="https://instagram.com/${username}" target="_blank" 
               style="color: #8e8e8e; text-decoration: none; font-size: 0.8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;">
              instagram.com/${username}
            </a>
          </div>
        </div>
        <div style="flex-shrink: 0; display: flex; gap: 8px; margin-left: 10px;">
          <span style="background: #ff4444; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; font-weight: bold;">
            #${index + 1}
          </span>
          <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                  style="flex-shrink: 0; padding: 6px 12px; background: #0095f6; color: white; border: none; 
                         border-radius: 6px; cursor: pointer; font-size: 0.85em; font-weight: 500; transition: background 0.2s;"
                  onmouseover="this.style.background='#0081d6'" onmouseout="this.style.background='#0095f6'">
            Vedi
          </button>
        </div>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div style="max-width: 900px; margin: 0 auto; padding: 0 15px;">
        <!-- Statistiche -->
        <div style="background: white; border-radius: 16px; padding: 30px; margin-bottom: 25px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="font-size: 2em; font-weight: 800; margin-bottom: 10px; color: #262626; letter-spacing: -0.5px;">
              📊 Risultati Analisi
            </div>
            <div style="color: #8e8e8e; font-size: 0.95em;">
              Dati estratti dal file ZIP di Instagram
            </div>
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px;">
            <div style="text-align: center; padding: 25px; background: linear-gradient(135deg, #f8f9fa, #ffffff); border-radius: 12px; border: 1px solid #efefef;">
              <div style="font-size: 3em; font-weight: 800; color: #0095f6; margin-bottom: 10px; letter-spacing: -1px;">${followingCount}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.95em;">Account che segui</div>
              <div style="color: #8e8e8e; font-size: 0.85em; margin-top: 5px;">Following</div>
            </div>
            
            <div style="text-align: center; padding: 25px; background: linear-gradient(135deg, #f8f9fa, #ffffff); border-radius: 12px; border: 1px solid #efefef;">
              <div style="font-size: 3em; font-weight: 800; color: #00a046; margin-bottom: 10px; letter-spacing: -1px;">${followersCount}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.95em;">Account che ti seguono</div>
              <div style="color: #8e8e8e; font-size: 0.85em; margin-top: 5px;">Followers</div>
            </div>
            
            <div style="text-align: center; padding: 25px; background: linear-gradient(135deg, #f8f9fa, #ffffff); border-radius: 12px; border: 1px solid #efefef;">
              <div style="font-size: 3em; font-weight: 800; color: #ff4444; margin-bottom: 10px; letter-spacing: -1px;">${notFollowingBack.length}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.95em;">Non ti seguono</div>
              <div style="color: #8e8e8e; font-size: 0.85em; margin-top: 5px;">Non reciprocati</div>
            </div>
          </div>
          
          <div style="background: linear-gradient(135deg, #f0f8ff, #e3f2fd); padding: 20px; border-radius: 12px; text-align: center; border-left: 5px solid #0095f6;">
            <div style="font-weight: 700; margin-bottom: 10px; color: #0095f6; font-size: 1.1em;">📈 Dettaglio rapporto</div>
            <div style="font-size: 1em; color: #37474f; line-height: 1.5;">
              <span style="font-weight: 700; color: #ff4444;">${notFollowingBack.length}</span> account su 
              <span style="font-weight: 700; color: #0095f6;">${followingCount}</span> che segui non ti seguono<br>
              (<span style="font-weight: 700; color: #ff4444;">${notFollowingPercentage}%</span> dei tuoi seguiti)
            </div>
          </div>
        </div>
        
        <!-- Lista degli account che non seguono -->
        ${notFollowingBack.length > 0 ? `
          <div style="background: white; border-radius: 16px; padding: 30px; margin-bottom: 25px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px;">
              <div>
                <div style="font-size: 1.5em; font-weight: 800; color: #262626; margin-bottom: 8px; letter-spacing: -0.5px;">
                  👥 Account che non ti seguono
                </div>
                <div style="color: #8e8e8e; font-size: 0.9em;">
                  Clicca "Vedi" per aprire il profilo su Instagram
                </div>
              </div>
              <div style="background: linear-gradient(135deg, #ff4444, #ff6b6b); color: white; padding: 8px 20px; 
                      border-radius: 20px; font-weight: 700; font-size: 0.95em; box-shadow: 0 2px 8px rgba(255,68,68,0.2);">
                ${notFollowingBack.length} account
              </div>
            </div>
            
            ${hasMore ? `
              <div style="background: linear-gradient(135deg, #fff3cd, #ffecb3); padding: 15px; border-radius: 10px; margin-bottom: 20px; 
                      border-left: 5px solid #ffc107; font-size: 0.9em; color: #856404;">
                ⚠️ Per motivi di performance, mostrati i primi 200 account su ${notFollowingBack.length} totali
              </div>
            ` : ''}
            
            <div style="max-height: 500px; overflow-y: auto; border: 1px solid #efefef; border-radius: 12px; background: #fafafa;">
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${listItems}
              </ul>
            </div>
            
            ${hasMore ? `
              <div style="text-align: center; margin-top: 20px; padding: 15px; color: #8e8e8e; font-size: 0.9em; background: #f8f9fa; border-radius: 10px;">
                <span style="font-weight: 600;">... e altri ${notFollowingBack.length - 200} account non mostrati</span><br>
                <span style="font-size: 0.85em;">(lista limitata per garantire le performance del browser)</span>
              </div>
            ` : ''}
          </div>
        ` : `
          <div style="text-align: center; padding: 50px; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
            <div style="font-size: 1.8em; font-weight: 800; margin-bottom: 15px; color: #262626; letter-spacing: -0.5px;">
              Ottimo risultato!
            </div>
            <div style="color: #666; margin-bottom: 30px; line-height: 1.6; font-size: 1.1em;">
              Tutti gli account che segui ti seguono a loro volta!<br>
              Hai un rapporto follower/seguaci perfetto.
            </div>
            <div style="background: linear-gradient(135deg, #f0f8ff, #e3f2fd); padding: 25px; border-radius: 12px; display: inline-block; 
                    border-left: 5px solid #0095f6; min-width: 300px;">
              <div style="font-weight: 700; color: #0095f6; margin-bottom: 10px; font-size: 1.1em;">📊 Bilancio follower</div>
              <div style="display: flex; justify-content: center; gap: 30px; font-size: 1.2em;">
                <div style="text-align: center;">
                  <div style="font-weight: 800; color: #0095f6; font-size: 2em;">${followingCount}</div>
                  <div style="color: #8e8e8e; font-size: 0.9em;">Seguiti</div>
                </div>
                <div style="align-self: center; color: #8e8e8e; font-size: 1.5em;">→</div>
                <div style="text-align: center;">
                  <div style="font-weight: 800; color: #00a046; font-size: 2em;">${followersCount}</div>
                  <div style="color: #8e8e8e; font-size: 0.9em;">Follower</div>
                </div>
              </div>
            </div>
          </div>
        `}
        
        <!-- Informazioni -->
        <div style="margin-top: 25px; padding: 20px; background: linear-gradient(135deg, #f8f9fa, #ffffff); 
                    border-radius: 12px; font-size: 0.9em; color: #666; border: 1px solid #efefef;">
          <div style="font-weight: 700; margin-bottom: 12px; color: #262626; font-size: 1em;">ℹ️ Informazioni tecniche</div>
          <div style="line-height: 1.6;">
            • <strong>Following:</strong> ${followingCount} account estratti dal campo "title" in relationships_following<br>
            • <strong>Followers:</strong> ${followersCount} account estratti dal campo "value" in string_list_data<br>
            • <strong>Non reciprocati:</strong> ${notFollowingBack.length} account che segui ma che non ti seguono<br>
            • L'analisi è eseguita localmente nel tuo browser, nessun dato viene inviato a server esterni
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
      <div style="text-align: center; padding: 50px 20px; max-width: 700px; margin: 0 auto;">
        <div style="font-size: 3.5em; margin-bottom: 20px;">📊</div>
        <div style="font-size: 2em; font-weight: 800; margin-bottom: 15px; color: #262626; letter-spacing: -0.5px;">
          Analizzatore Instagram
        </div>
        <div style="color: #666; margin-bottom: 30px; line-height: 1.6; font-size: 1.1em;">
          Scopri chi non ti segue su Instagram<br>
          analizzando i tuoi dati scaricati dalla piattaforma
        </div>
        
        <div style="background: linear-gradient(135deg, #f8f9fa, #ffffff); padding: 30px; border-radius: 16px; 
                    text-align: left; box-shadow: 0 4px 20px rgba(0,0,0,0.05); margin-bottom: 30px; border: 1px solid #efefef;">
          <div style="font-weight: 700; margin-bottom: 20px; color: #262626; font-size: 1.2em; display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.5em;">📥</span> Come ottenere i dati da Instagram
          </div>
          <ol style="margin: 0; padding-left: 22px; font-size: 0.95em; line-height: 1.8;">
            <li style="margin-bottom: 12px;">Vai su <strong>Instagram Web</strong> (versione desktop del browser)</li>
            <li style="margin-bottom: 12px;">Clicca sul tuo profilo → <strong>Impostazioni</strong> → <strong>Privacy e sicurezza</strong> → <strong>Dati personali</strong></li>
            <li style="margin-bottom: 12px;">Scarica dati → Seleziona <strong>"Seguaci e seguendo"</strong> → Formato JSON</li>
            <li>Riceverai un'email con il link per scaricare il file ZIP</li>
          </ol>
        </div>
        
        <div style="background: linear-gradient(135deg, #e8f4ff, #d4e7ff); padding: 20px; border-radius: 12px; 
                    display: inline-block; border-left: 5px solid #0095f6;">
          <div style="font-weight: 700; color: #0095f6; margin-bottom: 8px; font-size: 1.1em;">💡 Importante</div>
          <div style="font-size: 0.9em; color: #37474f; line-height: 1.5;">
            I dati devono essere scaricati da Instagram Desktop<br>
            I file devono contenere following.json e followers_*.json
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
          dropzone.style.background = 'linear-gradient(135deg, #f0f8ff, #e3f2fd)';
          dropzone.style.borderColor = '#0095f6';
          dropzone.style.transform = 'scale(1.02)';
          dropzone.style.boxShadow = '0 4px 15px rgba(0,149,246,0.2)';
        });
      });
      
      ['dragleave', 'drop'].forEach(ev => {
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.style.background = '';
          dropzone.style.borderColor = '';
          dropzone.style.transform = '';
          dropzone.style.boxShadow = '';
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
          <div style="text-align: center; padding: 50px 20px;">
            <div style="font-size: 3.5em; margin-bottom: 20px;">🔄</div>
            <div style="font-size: 1.8em; font-weight: 800; margin-bottom: 15px; color: #262626;">
              Pronto per una nuova analisi
            </div>
            <div style="color: #666; font-size: 1.1em;">
              Carica un nuovo file ZIP di Instagram
            </div>
          </div>
        `;
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento JSZip:', error);
    results.innerHTML = `
      <div style="text-align: center; padding: 50px 20px; background: linear-gradient(135deg, #ffebee, #ffcdd2); 
                  border-radius: 16px; max-width: 600px; margin: 0 auto;">
        <div style="font-size: 3em; margin-bottom: 20px;">❌</div>
        <div style="font-size: 1.5em; font-weight: 800; margin-bottom: 15px; color: #d32f2f;">
          Errore di caricamento
        </div>
        <div style="color: #666; line-height: 1.6; margin-bottom: 25px;">
          Impossibile caricare le librerie necessarie.<br>
          Ricarica la pagina o controlla la connessione internet.
        </div>
        <button onclick="window.location.reload()" 
                style="padding: 12px 30px; background: #d32f2f; color: white; border: none; 
                       border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 1em; transition: background 0.2s;"
                onmouseover="this.style.background='#b71c1c'" onmouseout="this.style.background='#d32f2f'">
          Ricarica la pagina
        </button>
      </div>
    `;
  });
});
