document.addEventListener('DOMContentLoaded',function(){
  function loadJSZip(){
    if(window.JSZip)return Promise.resolve(window.JSZip);
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload=()=>resolve(window.JSZip);
      s.onerror=()=>{
        const s2=document.createElement('script');
        s2.src='https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
        s2.onload=()=>resolve(window.JSZip);
        s2.onerror=()=>reject(new Error('Impossibile caricare JSZip'));
        document.head.appendChild(s2);
      };
      document.head.appendChild(s);
    });
  }
  function sanitizeUsername(raw){
    if(!raw)return null;
    raw=String(raw).trim();
    const urlm=raw.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|explore\/tags\/)?@?([A-Za-z0-9._-]+)/i);
    if(urlm)return urlm[1].toLowerCase();
    if(raw.startsWith('@'))raw=raw.slice(1);
    const m=raw.match(/^([A-Za-z0-9._-]+)/);
    return m?m[1].toLowerCase():null;
  }
  function uniqueSorted(arr){return Array.from(new Set(arr.filter(Boolean))).sort((a,b)=>a.localeCompare(b))}
  function extractUsernamesFromText(text){
    const found=new Set();
    if(!text)return[];
    const trimmed=String(text).trim();
    try{
      const j=JSON.parse(trimmed);
      (function walk(node){
        if(node===null||node===undefined)return;
        if(typeof node==='string'){
          const su=sanitizeUsername(node);
          if(su)found.add(su);
          const reUrl=/instagram\.com\/(?:p|explore\/tags\/)?@?([A-Za-z0-9._-]+)/ig;
          let m;
          while((m=reUrl.exec(node))!==null)found.add(m[1].toLowerCase());
          const reAt=/@([A-Za-z0-9._-]+)/g;
          while((m=reAt.exec(node))!==null)found.add(m[1].toLowerCase());
          return;
        }
        if(Array.isArray(node))node.forEach(walk);else if(typeof node==='object')Object.values(node).forEach(walk);
      })(j);
    }catch(e){
      const stripped=trimmed.replace(/<[^>]+>/g,'\n');
      const reUrl=/instagram\.com\/(?:p|explore\/tags\/)?@?([A-Za-z0-9._-]+)/ig;
      let m;
      while((m=reUrl.exec(stripped))!==null)found.add(m[1].toLowerCase());
      const reAt=/@([A-Za-z0-9._-]+)/g;
      while((m=reAt.exec(stripped))!==null)found.add(m[1].toLowerCase());
      stripped.split(/\r?\n/).forEach(l=>{const s=sanitizeUsername(l);if(s)found.add(s)});
    }
    return Array.from(found);
  }
  function renderList(list){
    if(!list||list.length===0){
      return '<div class="empty-state"><div class="empty-state-icon">🎉</div><div class="small"><strong>Ottime notizie!</strong><br>Non hai nessuno che non ti segue tra le persone che segui.</div></div>';
    }
    const userItems=list.map(u=>`<li class="user-item fade-in"><div style="display:flex;gap:10px;align-items:center"><div class="user-avatar">${u.charAt(0).toUpperCase()}</div><div class="user-details"><div class="username">@${u}</div><a class="profile-link" href="https://www.instagram.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener noreferrer">instagram.com/${u}</a></div></div><div><button class="action-btn" onclick="window.open('https://www.instagram.com/${encodeURIComponent(u)}/','_blank')">Vedi profilo</button></div></li>`).join('');
    return `<div class="results-container"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div class="results-count">👥 Persone che non ti seguono: ${list.length}</div></div><div class="results-scroll"><ul class="user-list">${userItems}</ul></div></div>`;
  }
  async function readJsonEntry(entryObj){
    const txt=await entryObj.entry.async('string');
    try{
      const j=JSON.parse(txt);
      const collected=new Set();
      (function walk(node){
        if(node===null||node===undefined)return;
        if(typeof node==='string'){
          const s=sanitizeUsername(node);
          if(s)collected.add(s);
          const re=/instagram\.com\/(?:p|explore\/tags\/)?@?([A-Za-z0-9._-]+)/ig;
          let m;
          while((m=re.exec(node))!==null)collected.add(m[1].toLowerCase());
          return;
        }
        if(Array.isArray(node))node.forEach(walk);else if(typeof node==='object')Object.values(node).forEach(walk);
      })(j);
      return Array.from(collected);
    }catch(e){
      return extractUsernamesFromText(txt);
    }
  }
  const results=document.getElementById('results');
  const zipInput=document.getElementById('zipfile');
  const drop=document.getElementById('dropzone');
  const resetBtn=document.getElementById('resetBtn');
  const ddToggle=document.getElementById('ddToggle');
  const ddPanel=document.getElementById('ddPanel');
  const statusPill=document.getElementById('statusPill');
  let JSZipLoaded=false;
  results.innerHTML='<div class="small loading">🔄 Caricamento libreria JSZip...</div>';
  const selectZipLabel=document.getElementById('selectZipLabel');
  selectZipLabel.style.opacity='0.5';
  selectZipLabel.style.cursor='not-allowed';
  loadJSZip().then((JSZip)=>{
    JSZipLoaded=true;
    statusPill.textContent='✅ Pronto';
    statusPill.className='pill small success';
    results.innerHTML='<div class="small fade-in">✅ <strong>Pronto!</strong> Carica un file ZIP esportato da Instagram per iniziare l\\analisi.</div>';
    selectZipLabel.style.opacity='1';
    selectZipLabel.style.cursor='pointer';
    try{if(window.__adsHelperInit)window.__adsHelperInit()}catch(e){}
  }).catch((error)=>{
    statusPill.textContent='❌ Errore caricamento';
    statusPill.className='pill small error';
    results.innerHTML=`<div class="error fade-in"><strong>❌ Errore nel caricamento della libreria</strong><br><br><strong>Possibili cause:</strong><br>• Problemi di connessione Internet<br>• Blocco degli script esterni<br><br><strong>Soluzioni:</strong><br>• Verifica la connessione Internet<br>• Disabilita eventuali blocca-script<br>• Prova a ricaricare la pagina</div>`;
    selectZipLabel.style.opacity='0.5';
    selectZipLabel.style.cursor='not-allowed';
  });
  if(ddToggle)ddToggle.addEventListener('click',function(){
    const isOpen=ddPanel.classList.toggle('open');
    ddToggle.setAttribute('aria-expanded',isOpen);
    ddPanel.style.display=isOpen?'block':'none';
  });
  async function processZip(file){
    if(!JSZipLoaded){results.innerHTML='<div class="error">JSZip non è ancora caricato. Attendere...</div>';return}
    results.innerHTML='<div class="small loading">🔄 Analisi in corso... Questo potrebbe richiedere alcuni secondi.</div>';
    try{
      const arrayBuffer=await file.arrayBuffer();
      const zip=await window.JSZip.loadAsync(arrayBuffer);
      const targetPrefix='connections/followers_and_following/';
      const files=[];
      zip.forEach((relativePath,zipEntry)=>{
        const lp=relativePath.replace(/^\/+/,'');
        if(lp.toLowerCase().startsWith(targetPrefix) && !zipEntry.dir){
          const name=lp.slice(targetPrefix.length);
          files.push({path:lp,name,entry:zipEntry});
        }
      });
      if(files.length===0){
        results.innerHTML='<div class="error">Nessun file trovato nella cartella "connections/followers_and_following" dello ZIP. Assicurati di aver esportato correttamente i dati da Instagram.</div>';
        return;
      }
      const primaryFile=files.find(f=>/^following(?:\.[^.]*)?$/i.test(f.name));
      const compareFiles=files.filter(f=>/^followers_.*\.json$/i.test(f.name));
      if(!primaryFile){results.innerHTML='<div class="error">Impossibile trovare "following.json" nella cartella prevista. Il file ZIP potrebbe non essere corretto.</div>';return}
      if(compareFiles.length===0){results.innerHTML='<div class="error">Nessun file "followers_*.json" trovato. Assicurati di aver esportato sia i follower che i following da Instagram.</div>';return}
      const primaryList=await readJsonEntry(primaryFile);
      let othersList=[];
      for(const cf of compareFiles){const l=await readJsonEntry(cf);othersList=othersList.concat(l)}
      const primaryU=uniqueSorted(primaryList);
      const othersU=uniqueSorted(othersList);
      const othersSet=new Set(othersU);
      const missing=primaryU.filter(u=>!othersSet.has(u));
      results.innerHTML=renderList(missing);
      try{if(window.__adsHelperInit)window.__adsHelperInit()}catch(e){}
    }catch(err){
      results.innerHTML=`<div class="error">❌ Errore durante l'analisi: ${String(err)}<br><br>Assicurati di aver selezionato un file ZIP valido esportato da Instagram.</div>`;
    }
  }
  if(zipInput){
    zipInput.addEventListener('change',function(e){
      if(!JSZipLoaded){results.innerHTML='<div class="error">JSZip non è ancora caricato. Attendere...</div>';return}
      const file=e.target.files[0];
      if(file && file.name.endsWith('.zip')){processZip(file)}else if(file){results.innerHTML='<div class="error">Per favore seleziona un file ZIP valido esportato da Instagram.</div>'}
    });
  }
  if(resetBtn)resetBtn.addEventListener('click',function(){
    if(zipInput)zipInput.value='';
    results.innerHTML=JSZipLoaded?'<div class="small fade-in">✅ <strong>Pronto!</strong> Carica un file ZIP esportato da Instagram per iniziare.</div>':'<div class="small loading">🔄 Caricamento libreria JSZip...</div>';
  });
  ['dragenter','dragover'].forEach(ev=>{if(drop)drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('drag-over')})});
  ['dragleave','drop'].forEach(ev=>{if(drop)drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('drag-over')})});
  if(drop)drop.addEventListener('drop',function(e){
    e.preventDefault();
    if(!JSZipLoaded){results.innerHTML='<div class="error">JSZip non è ancora caricato. Attendere...</div>';return}
    const file=e.dataTransfer.files[0];
    if(file && file.name.endsWith('.zip')){processZip(file)}else if(file){results.innerHTML='<div class="error">Per favore seleziona un file ZIP valido esportato da Instagram.</div>'}
  });
  window.addEventListener('beforeunload',function(e){
    if(results.innerHTML.includes('Analisi in corso') || results.querySelector('.results-container')){
      e.preventDefault();
      e.returnValue='Sei sicuro di voler lasciare la pagina? I risultati dell\'analisi andranno persi.';
    }
  });
  try{fetch('footer.html').then(r=>r.text()).then(t=>{document.getElementById('footer-container').innerHTML=t}).catch(()=>{document.getElementById('footer-container').innerHTML='<div class=\"footer\">Instagram Follower Tracker v2.0</div>'})}catch(e){}
});
