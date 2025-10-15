(function(){
  const AD_CREATED_FLAG = 'data-ad-created';
  const DEFAULT_MIN_WIDTH = 300;
  function getMinWidth(container){const attr=container.getAttribute('data-min-width');return attr?parseInt(attr,10):DEFAULT_MIN_WIDTH}
  function createInsElement(options){
    const ins=document.createElement('ins');
    ins.className='adsbygoogle';
    ins.style.display='block';
    ins.setAttribute('data-ad-client',options.client);
    if(options.slot)ins.setAttribute('data-ad-slot',options.slot);
    if(options.format)ins.setAttribute('data-ad-format',options.format);
    if(options.fullWidthResponsive)ins.setAttribute('data-full-width-responsive','true');
    return ins;
  }
  function pushAd(ins){
    try{(adsbygoogle=window.adsbygoogle||[]).push({});ins.setAttribute(AD_CREATED_FLAG,'1')}catch(e){console.warn('AdSense push failed',e)}
  }
  function removeAd(container){
    const inner=container.querySelector('.ad-inner');
    if(!inner)return;
    const ins=inner.querySelector('.adsbygoogle');
    if(ins){try{inner.removeChild(ins)}catch(e){}}
    container.classList.remove('ad-enabled');
    container.classList.add('ad-placeholder');
    container.removeAttribute(AD_CREATED_FLAG);
  }
  function createAdSlot(containerId){
    const container=document.getElementById(containerId);
    if(!container)return;
    const inner=container.querySelector('.ad-inner');
    if(!inner)return;
    const slot=container.getAttribute('data-slot');
    const minWidth=getMinWidth(container);
    const available=Math.floor(inner.getBoundingClientRect().width);
    if(available<minWidth){removeAd(container);return}
    if(container.getAttribute(AD_CREATED_FLAG)==='1'){container.classList.add('ad-enabled');container.classList.remove('ad-placeholder');return}
    inner.innerHTML='';
    const ins=createInsElement({client:'ca-pub-1948802026580753',slot:slot,format:'auto',fullWidthResponsive:true});
    inner.appendChild(ins);
    const finalAvailable=Math.floor(inner.getBoundingClientRect().width);
    if(finalAvailable<Math.max(120,Math.floor(minWidth*0.5))){inner.removeChild(ins);container.classList.add('ad-placeholder');return}
    container.classList.remove('ad-placeholder');
    container.classList.add('ad-enabled');
    pushAd(ins);
  }
  function observeAdContainers(){
    const containers=Array.from(document.querySelectorAll('.ad-container'));
    if(!containers.length)return;
    const ro=new ResizeObserver(entries=>{
      for(const entry of entries){const container=entry.target;createAdSlot(container.id)}
    });
    containers.forEach(c=>{
      setTimeout(()=>createAdSlot(c.id),100);
      try{ro.observe(c)}catch(e){}
    });
    window.addEventListener('resize',()=>{containers.forEach(c=>createAdSlot(c.id))},{passive:true});
  }
  window.__adsHelperInit=function(){
    observeAdContainers();
  };
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',window.__adsHelperInit)}else{window.__adsHelperInit()}
})();
