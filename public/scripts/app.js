document.addEventListener('DOMContentLoaded', function() {
  // ========== CONFIGURAZIONE FILTRI ==========
  const FILTER_CONFIG = {
    MIN_USERNAME_LENGTH: 3,
    MAX_USERNAME_LENGTH: 30,
    EXCLUDE_PATTERNS: [
      /^(?:user|instagram|official|_.+|.+_)$/i,
      /^[0-9]+$/,
      /^[a-z]{1,2}$/i,
      /.*(?:bot|spam|fake|test|dummy).*/i,
      /.*[0-9]{8,}.*/
    ],
    EXCLUDE_KEYWORDS: [
      'deleted', 'removed', 'unavailable', 'instagrammer',
      'fanpage', 'page', 'business', 'shop', 'store'
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
    
    for (const keyword of FILTER_CONFIG.EXCLUDE_KEYWORDS) {
      if (cleanUsername.includes(keyword)) return false;
    }
    
    if (/(.)\1{4,}/.test(cleanUsername)) return false;
    
    return cleanUsername;
  }

  function extractUsername(raw) {
    if (!raw) return null;
    
    const rawStr = String(raw).trim();
    let extracted = null;
    
    const patterns = [
      /instagram\.com\/(?:p\/|reel\/|stories\/|explore\/tags\/)?@?([a-z0-9._]+)/i,
      /https?:\/\/(?:www\.)?instagram\.com\/(?:p\/|reel\/|stories\/|explore\/tags\/)?@?([a-z0-9._]+)/i,
      /^@([a-z0-9._]+)$/i,
      /^([a-z0-9._]+)$/i
    ];
    
    for (const pattern of patterns) {
      const match = rawStr.match(pattern);
      if (match && match[1]) {
        extracted = match[1].toLowerCase();
        break;
      }
    }
    
    return extracted ? isValidInstagramUsername(extracted) : null;
  }

  // ========== ANALISI FILE JSON ==========
  function analyzeJsonData(jsonContent) {
    const extractedUsernames = new Set();
    
    try {
      const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      
      function traverse(obj) {
        if (!obj || typeof obj !== 'object') return;
        
        if (Array.isArray(obj)) {
          obj.forEach(traverse);
          return;
        }
        
        if (typeof obj === 'object') {
          if (obj.title && typeof obj.title === 'string') {
            const username = extractUsername(obj.title);
            if (username) extractedUsernames.add(username);
          }
          
          if (obj.value && typeof obj.value === 'string') {
            const username = extractUsername(obj.value);
            if (username) extractedUsernames.add(username);
          }
          
          if (obj.href && typeof obj.href === 'string') {
            const username = extractUsername(obj.href);
            if (username) extractedUsernames.add(username);
          }
          
          if (obj.string_list_data && Array.isArray(obj.string_list_data)) {
            obj.string_list_data.forEach(traverse);
          }
          
          if (obj.relationships_following && Array.isArray(obj.relationships_following)) {
            obj.relationships_following.forEach(traverse);
          }
          
          Object.values(obj).forEach(traverse);
        }
      }
      
      traverse(data);
    } catch (error) {
      console.error('Errore analisi JSON:', error);
    }
    
    return Array.from(extractedUsernames);
  }

  // ========== FILTRAGGIO AVANZATO ==========
  function filterInvalidAccounts(usernames) {
    return usernames.filter(username => {
      const digitCount = (username.match(/\d/g) || []).length;
      if (digitCount > 5) return false;
      
      if (username.includes('...') || username.includes('___')) return false;
      
      const genericPatterns = ['user', 'insta', 'gram', 'follow', 'like', 'comment'];
      for (const pattern of genericPatterns) {
        if (username === pattern || 
            username.startsWith(pattern + '_') || 
            username.endsWith('_' + pattern)) {
          return false;
        }
      }
      
      return true;
    });
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
    results.innerHTML = '<div class="loading">🔄 Analisi in corso...</div>';
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      
      let followingData = null;
      const followersData = [];
      
      zip.forEach((path, entry) => {
        if (!entry.dir) {
          const lowerPath = path.toLowerCase();
          
          if (lowerPath.includes('following') && lowerPath.endsWith('.json')) {
            followingData = entry;
          }
          
          if (lowerPath.includes('follower') && lowerPath.endsWith('.json')) {
            followersData.push(entry);
          }
        }
      });
      
      if (!followingData) throw new Error('File following.json non trovato');
      if (followersData.length === 0) throw new Error('File follower non trovati');
      
      const followingContent = await followingData.async('string');
      const followingUsernamesRaw = analyzeJsonData(followingContent);
      const followingUsernames = filterInvalidAccounts(followingUsernamesRaw);
      
      const allFollowers = new Set();
      for (const followerFile of followersData) {
        const followerContent = await followerFile.async('string');
        const followerUsernamesRaw = analyzeJsonData(followerContent);
        const followerUsernames = filterInvalidAccounts(followerUsernamesRaw);
        followerUsernames.forEach(u => allFollowers.add(u));
      }
      
      const followersArray = Array.from(allFollowers);
      const followersSet = new Set(followersArray);
      
      const notFollowingBack = followingUsernames.filter(u => !followersSet.has(u));
      
      displayResults(notFollowingBack, followingUsernames.length, followersArray.length);
      
      statusPill.textContent = '✅ Completo';
      statusPill.className = 'pill success';
      
    } catch (error) {
      statusPill.textContent = '❌ Errore';
      statusPill.className = 'pill error';
      results.innerHTML = `<div class="error">Errore: ${error.message}</div>`;
    }
  }

  // ========== VISUALIZZAZIONE RISULTATI ==========
  function displayResults(notFollowingBack, followingCount, followersCount) {
    const results = document.getElementById('results');
    
    if (notFollowingBack.length === 0) {
      results.innerHTML = `
        <div class="success">
          <div style="font-size: 3em; margin-bottom: 10px;">🎉</div>
          <strong>Ottime notizie!</strong><br>
          Tutti i ${followingCount} account che segui ti seguono a loro volta!
        </div>
      `;
      return;
    }
    
    const listItems = notFollowingBack.map(username => `
      <li class="user-item">
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 32px; height: 32px; border-radius: 50%; background: #e0e0e0; display: flex; align-items: center; justify-content: center; font-weight: bold;">
              ${username.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style="font-weight: bold;">@${username}</div>
              <a href="https://instagram.com/${username}" target="_blank" style="font-size: 0.9em; color: #666;">
                instagram.com/${username}
              </a>
            </div>
          </div>
          <button onclick="window.open('https://instagram.com/${username}', '_blank')" 
                  style="padding: 5px 15px; background: #405de6; color: white; border: none; border-radius: 4px; cursor: pointer;">
            Vedi
          </button>
        </div>
      </li>
    `).join('');
    
    results.innerHTML = `
      <div style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
          <div>
            <strong>👥 Account che non ti seguono:</strong> ${notFollowingBack.length}
          </div>
          <div style="font-size: 0.9em; color: #666;">
            ${followingCount} seguiti → ${followersCount} follower
          </div>
        </div>
        <div style="background: #f0f0f0; padding: 10px; border-radius: 5px; font-size: 0.9em; margin-bottom: 15px;">
          <strong>Filtri applicati:</strong> Rimossi account inattivi, spam, non validi e pattern sospetti
        </div>
        <ul style="list-style: none; padding: 0; max-height: 400px; overflow-y: auto;">
          ${listItems}
        </ul>
      </div>
    `;
  }

  // ========== INIZIALIZZAZIONE ==========
  loadJSZip().then(() => {
    const results = document.getElementById('results');
    const statusPill = document.getElementById('statusPill');
    
    statusPill.textContent = '✅ Pronto';
    statusPill.className = 'pill success';
    results.innerHTML = '<div>✅ Pronto! Carica il file ZIP di Instagram.</div>';
    
    const zipInput = document.getElementById('zipfile');
    const dropzone = document.getElementById('dropzone');
    const resetBtn = document.getElementById('resetBtn');
    
    if (zipInput) {
      zipInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file && file.name.endsWith('.zip')) {
          processZipFile(file);
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
        }
      });
    }
    
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (zipInput) zipInput.value = '';
        results.innerHTML = '<div>✅ Pronto! Carica il file ZIP di Instagram.</div>';
        statusPill.textContent = '✅ Pronto';
        statusPill.className = 'pill success';
      });
    }
    
  }).catch(error => {
    console.error('Errore caricamento JSZip:', error);
    document.getElementById('results').innerHTML = `
      <div class="error">
        ❌ Errore caricamento libreria. Ricarica la pagina.
      </div>
    `;
  });
});
