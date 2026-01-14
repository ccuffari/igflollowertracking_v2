document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE ==========
  const CONFIG = {
    MIN_USERNAME_LENGTH: 1,
    MAX_USERNAME_LENGTH: 50
  };

  // ========== FUNZIONI DI ESTRAZIONE SEMPLIFICATE ==========
  function cleanInstagramUsername(username) {
    if (!username || typeof username !== 'string') return null;
    
    const cleanUsername = username.trim().toLowerCase();
    
    // Controllo base di validità
    if (cleanUsername.length < CONFIG.MIN_USERNAME_LENGTH || 
        cleanUsername.length > CONFIG.MAX_USERNAME_LENGTH) return null;
    
    // Solo caratteri validi per Instagram
    if (!/^[a-z0-9._]+$/.test(cleanUsername)) return null;
    
    return cleanUsername;
  }

  // ========== ANALISI FOLLOWERS ==========
  function extractFollowersUsernames(jsonData) {
    const usernames = new Set();
    
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      
      console.log("=== ANALISI FOLLOWERS ===");
      console.log("Struttura dati:", Array.isArray(data) ? "Array" : typeof data);
      
      if (Array.isArray(data)) {
        console.log(`Numero elementi nell'array: ${data.length}`);
        
        let valoriTrovati = 0;
        let valoriNonValidati = 0;
        
        data.forEach((item, index) => {
          if (item.string_list_data && Array.isArray(item.string_list_data)) {
            item.string_list_data.forEach(stringItem => {
              // ESTRAI DAL CAMPO "value" - SOLO QUESTO
              if (stringItem.value && stringItem.value.trim() !== "") {
                const username = cleanInstagramUsername(stringItem.value);
                if (username) {
                  usernames.add(username);
                  valoriTrovati++;
                  
                  // Log dei primi 5 valori trovati
                  if (valoriTrovati <= 5) {
                    console.log(`  [${valoriTrovati}] Value trovato: "${stringItem.value}" -> "${username}"`);
                  }
                } else {
                  valoriNonValidati++;
                }
              }
            });
          }
        });
        
        console.log(`Valori "value" trovati: ${valoriTrovati}`);
        console.log(`Valori non validati: ${valoriNonValidati}`);
      } else {
        console.error("ERRORE: I followers non sono in un array. Struttura:", data);
      }
      
      console.log(`TOTALE followers unici estratti: ${usernames.size}`);
      console.log("=== FINE ANALISI FOLLOWERS ===");
      
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
      
      console.log("=== ANALISI FOLLOWING ===");
      console.log("Struttura dati:", typeof data);
      console.log("Chiavi presenti:", Object.keys(data));
      
      // DEVE ESSERE PRESENTE relationships_following
      if (data.relationships_following && Array.isArray(data.relationships_following)) {
        console.log(`Numero elementi in relationships_following: ${data.relationships_following.length}`);
        
        let titoliTrovati = 0;
        let titoliNonValidati = 0;
        
        data.relationships_following.forEach((item, index) => {
          // ESTRAI DAL CAMPO "title" - SOLO QUESTO
          if (item.title && item.title.trim() !== "") {
            const username = cleanInstagramUsername(item.title);
            if (username) {
              usernames.add(username);
              titoliTrovati++;
              
              // Log dei primi 5 titoli trovati
              if (titoliTrovati <= 5) {
                console.log(`  [${titoliTrovati}] Title trovato: "${item.title}" -> "${username}"`);
              }
            } else {
              titoliNonValidati++;
            }
          }
        });
        
        console.log(`Titoli "title" trovati: ${titoliTrovati}`);
        console.log(`Titoli non validati: ${titoliNonValidati}`);
      } else {
        console.error("ERRORE: relationships_following non trovato o non è un array");
        console.log("Contenuto del file:", JSON.stringify(data, null, 2).substring(0, 1000));
      }
      
      console.log(`TOTALE following unici estratti: ${usernames.size}`);
      console.log("=== FINE ANALISI FOLLOWING ===");
      
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

  // ========== GESTIONE ZIP SEMPLIFICATA ==========
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
          <small>Apri la console del browser (F12) per vedere i dettagli</small>
        </div>
      </div>
    `;
    
    try {
      console.clear();
      console.log("=== INIZIO ANALISI ZIP ===");
      console.log("File caricato:", file.name, `(${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      
      const arrayBuffer = await file.arrayBuffer();
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      
      // CERCA SOLO I FILE CHE CI SERVONO
      let followingFile = null;
      const followerFiles = [];
      
      zip.forEach((path, entry) => {
        if (!entry.dir) {
          const lowerPath = path.toLowerCase();
          
          // SOLO following.json (ignora tutti gli altri file)
          if (lowerPath.endsWith('following.json')) {
            console.log(`✓ Trovato following.json: ${path}`);
            followingFile = entry;
          }
          
          // SOLO file che iniziano con followers (followers_1.json, followers_2.json, ecc.)
          if (lowerPath.includes('followers') && lowerPath.endsWith('.json')) {
            console.log(`✓ Trovato file follower: ${path}`);
            followerFiles.push(entry);
          }
        }
      });
      
      console.log(`\nFile trovati:`);
      console.log(`- following.json: ${followingFile ? 'SÌ' : 'NO'}`);
      console.log(`- File followers: ${followerFiles.length} (${followerFiles.map(f => f.name).join(', ')})`);
      
      if (!followingFile) throw new Error('File "following.json" non trovato nel ZIP');
      if (followerFiles.length === 0) throw new Error('Nessun file "followers" trovato nel ZIP');
      
      // 1. LEGGI E ANALIZZA FOLLOWING
      console.log("\n" + "=".repeat(50));
      console.log("1. ANALISI FOLLOWING.JSON");
      console.log("=".repeat(50));
      
      const followingContent = await followingFile.async('string');
      console.log(`Dimensione file: ${followingContent.length} caratteri`);
      console.log("Prime 500 caratteri del file:", followingContent.substring(0, 500));
      
      const followingUsernames = extractFollowingUsernames(followingContent);
      
      // 2. LEGGI E ANALIZZA TUTTI I FILE FOLLOWERS
      console.log("\n" + "=".repeat(50));
      console.log("2. ANALISI FILE FOLLOWERS");
      console.log("=".repeat(50));
      
      const allFollowers = new Set();
      for (const followerFile of followerFiles) {
        console.log(`\n--- Analisi file: ${followerFile.name} ---`);
        const followerContent = await followerFile.async('string');
        console.log(`Dimensione file: ${followerContent.length} caratteri`);
        
        const followerUsernames = extractFollowersUsernames(followerContent);
        console.log(`Aggiunti ${followerUsernames.length} username da questo file`);
        
        followerUsernames.forEach(u => allFollowers.add(u));
      }
      
      const followersArray = Array.from(allFollowers);
      
      // 3. RISULTATI E DIFF
      console.log("\n" + "=".repeat(50));
      console.log("3. RISULTATI FINALI");
      console.log("=".repeat(50));
      
      console.log(`Following estratti: ${followingUsernames.length}`);
      console.log(`Followers estratti: ${followersArray.length}`);
      
      console.log("\nPrimi 10 following:");
      followingUsernames.slice(0, 10).forEach((u, i) => console.log(`  ${i+1}. @${u}`));
      
      console.log("\nPrimi 10 followers:");
      followersArray.slice(0, 10).forEach((u, i) => console.log(`  ${i+1}. @${u}`));
      
      // 4. TROVA CHI NON SEGUE
      const followersSet = new Set(followersArray);
      const notFollowingBack = followingUsernames.filter(u => !followersSet.has(u));
      
      console.log(`\nNon following back: ${notFollowingBack.length}`);
      if (notFollowingBack.length > 0) {
        console.log("Primi 10 non following back:");
        notFollowingBack.slice(0, 10).forEach((u, i) => console.log(`  ${i+1}. @${u}`));
      }
      
      // 5. MOSTRA RISULTATI
      displayResults(notFollowingBack, followingUsernames.length, followersArray.length);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      console.error('Errore:', error);
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `
        <div style="text-align: center; padding: 40px; background: #ffebee; border-radius: 12px;">
          <div style="font-size: 3em; margin-bottom: 20px;">⚠️</div>
          <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 15px; color: #d32f2f;">Errore nell'analisi</div>
          <div style="color: #666; margin-bottom: 20px; line-height: 1.5;">${error.message}</div>
          <div style="font-size: 0.9em; color: #999;">
            Controlla la console (F12) per vedere i dettagli dell'errore e i file trovati.
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
          <div style="flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; background: #f0f0f0; 
                      display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.9em;">
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
        <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                style="flex-shrink: 0; padding: 6px 12px; background: #0095f6; color: white; border: none; 
                       border-radius: 6px; cursor: pointer; font-size: 0.85em; font-weight: 500; transition: background 0.2s;"
                onmouseover="this.style.background='#0081d6'" onmouseout="this.style.background='#0095f6'">
          Vedi
        </button>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div style="max-width: 900px; margin: 0 auto; padding: 0 15px;">
        <!-- Statistiche -->
        <div style="background: white; border-radius: 16px; padding: 30px; margin-bottom: 25px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="font-size: 2em; font-weight: 800; margin-bottom: 10px; color: #262626;">
              📊 Risultati Analisi
            </div>
            <div style="color: #8e8e8e; font-size: 0.95em;">
              Dati estratti esclusivamente da following.json e followers.json
            </div>
          </div>
          
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px;">
            <div style="text-align: center; padding: 25px; background: #f8f9fa; border-radius: 12px; border: 1px solid #efefef;">
              <div style="font-size: 3em; font-weight: 800; color: #0095f6; margin-bottom: 10px;">${followingCount}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.95em;">Following</div>
              <div style="color: #8e8e8e; font-size: 0.85em; margin-top: 5px;">Estratti da title</div>
            </div>
            
            <div style="text-align: center; padding: 25px; background: #f8f9fa; border-radius: 12px; border: 1px solid #efefef;">
              <div style="font-size: 3em; font-weight: 800; color: #00a046; margin-bottom: 10px;">${followersCount}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.95em;">Followers</div>
              <div style="color: #8e8e8e; font-size: 0.85em; margin-top: 5px;">Estratti da value</div>
            </div>
            
            <div style="text-align: center; padding: 25px; background: #f8f9fa; border-radius: 12px; border: 1px solid #efefef;">
              <div style="font-size: 3em; font-weight: 800; color: #ff4444; margin-bottom: 10px;">${notFollowingBack.length}</div>
              <div style="color: #262626; font-weight: 600; font-size: 0.95em;">Non ti seguono</div>
              <div style="color: #8e8e8e; font-size: 0.85em; margin-top: 5px;">Non reciprocati</div>
            </div>
          </div>
          
          <div style="background: #f0f8ff; padding: 20px; border-radius: 12px; text-align: center;">
            <div style="font-weight: 700; margin-bottom: 10px; color: #0095f6; font-size: 1.1em;">📈 Rapporto</div>
            <div style="font-size: 1em; color: #37474f; line-height: 1.5;">
              <span style="font-weight: 700; color: #ff4444;">${notFollowingBack.length}</span> su 
              <span style="font-weight: 700; color: #0095f6;">${followingCount}</span> following non ti seguono<br>
              (<span style="font-weight: 700; color: #ff4444;">${notFollowingPercentage}%</span> dei tuoi seguiti)
            </div>
          </div>
        </div>
        
        <!-- Lista degli account che non seguono -->
        ${notFollowingBack.length > 0 ? `
          <div style="background: white; border-radius: 16px; padding: 30px; margin-bottom: 25px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px;">
              <div>
                <div style="font-size: 1.5em; font-weight: 800; color: #262626; margin-bottom: 8px;">
                  👥 Account che non ti seguono
                </div>
                <div style="color: #8e8e8e; font-size: 0.9em;">
                  Clicca "Vedi" per aprire il profilo su Instagram
                </div>
              </div>
              <div style="background: #ff4444; color: white; padding: 8px 20px; 
                      border-radius: 20px; font-weight: 700; font-size: 0.95em;">
                ${notFollowingBack.length} account
              </div>
            </div>
            
            ${hasMore ? `
              <div style="background: #fff3cd; padding: 15px; border-radius: 10px; margin-bottom: 20px; 
                      font-size: 0.9em; color: #856404;">
                ⚠️ Mostrati i primi 200 account su ${notFollowingBack.length} totali
              </div>
            ` : ''}
            
            <div style="max-height: 500px; overflow-y: auto; border: 1px solid #efefef; border-radius: 12px;">
              <ul style="list-style: none; padding: 0; margin: 0;">
                ${listItems}
              </ul>
            </div>
            
            ${hasMore ? `
              <div style="text-align: center; margin-top: 20px; padding: 15px; color: #8e8e8e; font-size: 0.9em;">
                <span style="font-weight: 600;">... e altri ${notFollowingBack.length - 200} account</span>
              </div>
            ` : ''}
          </div>
        ` : `
          <div style="text-align: center; padding: 50px; background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
            <div style="font-size: 4em; margin-bottom: 20px;">🎉</div>
            <div style="font-size: 1.8em; font-weight: 800; margin-bottom: 15px; color: #262626;">
              Ottimo risultato!
            </div>
            <div style="color: #666; margin-bottom: 30px; line-height: 1.6; font-size: 1.1em;">
              Tutti i tuoi ${followingCount} following ti seguono a loro volta!
            </div>
          </div>
        `}
        
        <!-- Info -->
        <div style="margin-top: 25px; padding: 20px; background: #f8f9fa; border-radius: 12px; font-size: 0.9em; color: #666;">
          <div style="font-weight: 700; margin-bottom: 12px; color: #262626;">ℹ️ Informazioni</div>
          <div style="line-height: 1.6;">
            • Following: ${followingCount} account estratti dal campo "title" in relationships_following<br>
            • Followers: ${followersCount} account estratti dal campo "value" in string_list_data<br>
            • Non reciprocati: ${notFollowingBack.length} account che segui ma che non ti seguono
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
        <div style="font-size: 2em; font-weight: 800; margin-bottom: 15px; color: #262626;">
          Analizzatore Instagram
        </div>
        <div style="color: #666; margin-bottom: 30px; line-height: 1.6; font-size: 1.1em;">
          Carica il file ZIP di Instagram per scoprire<br>
          <strong>chi non ti segue</strong>
        </div>
        <div style="background: #f0f8ff; padding: 15px; border-radius: 10px; margin-top: 20px;">
          <div style="font-weight: 600; color: #0095f6; margin-bottom: 10px;">📥 Come ottenere i dati</div>
          <div style="font-size: 0.9em; color: #555; line-height: 1.5;">
            1. Scarica i tuoi dati da Instagram<br>
            2. Estrai il file ZIP<br>
            3. Carica il file ZIP qui<br>
            <br>
            <strong>Importante:</strong> Apri la console (F12 → Console) per vedere i dettagli dell'analisi
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
      <div style="text-align: center; padding: 50px 20px; background: #ffebee; border-radius: 16px; max-width: 600px; margin: 0 auto;">
        <div style="font-size: 3em; margin-bottom: 20px;">❌</div>
        <div style="font-size: 1.5em; font-weight: 800; margin-bottom: 15px; color: #d32f2f;">
          Errore di caricamento
        </div>
        <div style="color: #666; line-height: 1.6; margin-bottom: 25px;">
          Impossibile caricare le librerie necessarie.<br>
          Ricarica la pagina o controlla la connessione internet.
        </div>
      </div>
    `;
  });
});
