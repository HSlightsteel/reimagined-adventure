const API=location.origin;
let currentPage='dashboard';

function $(s){return document.querySelector(s)}
function $$(s){return document.querySelectorAll(s)}

// Nav
$$('.sb-item').forEach(b=>b.addEventListener('click',()=>switchPage(b.dataset.page)));
$$('.mob-tab').forEach(b=>b.addEventListener('click',()=>switchPage(b.dataset.page)));

function switchPage(p){
  currentPage=p;
  $$('.sb-item').forEach(b=>b.classList.toggle('active',b.dataset.page===p));
  $$('.mob-tab').forEach(b=>b.classList.toggle('active',b.dataset.page===p));
  $$('.page').forEach(pg=>pg.classList.toggle('active',pg.id==='page-'+p));
  if(p==='dashboard')loadDashboard();
  if(p==='library')loadLibrary();
  if(p==='recordings')loadRecordings();
  if(p==='live')loadLive();
}

function toast(m){const e=$('#toast');e.textContent=m;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2500)}
function fmtDur(s){if(!s)return'0:00';const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;return h>0?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`}
function fmtSize(mb){return mb>=1024?(mb/1024).toFixed(1)+' GB':mb+' MB'}
function fmtDate(d){return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}
function ini(n){return(n||'?')[0].toUpperCase()}
function ld(){return'<div class="loading"><div class="spinner"></div></div>'}
function empty(i,t){return`<div class="empty"><div class="empty-icon">${i}</div><p>${t}</p></div>`}
function avatarImg(u,sz){return`<img src="${API}/api/avatar/${u}" alt="${u}" onerror="this.parentElement.textContent='${ini(u)}'" loading="lazy" style="width:${sz||'100%'};height:${sz||'100%'};object-fit:cover">`}

async function loadDashboard(){
  const el=$('#dash-content');el.innerHTML=ld();
  try{
    const[sr,wl,lr]=await Promise.all([fetch(API+'/api/status').then(r=>r.json()),fetch(API+'/api/watchlist').then(r=>r.json()),fetch(API+'/api/live').then(r=>r.json())]);
    const active=sr.activeRecordings||[];
    const uploads=sr.activeUploads||[];
    const liveCount=(lr.users||[]).filter(u=>u.isLive).length;
    let h=`<div class="dash-grid">`;
    h+=`<div class="stat-card"><div class="stat-val" style="color:var(--accent)">${active.length}</div><div class="stat-lbl">Active Recordings</div></div>`;
    h+=`<div class="stat-card"><div class="stat-val" style="color:orange">${uploads.length}</div><div class="stat-lbl">Active Uploads</div></div>`;
    h+=`<div class="stat-card"><div class="stat-val" style="color:var(--green)">${liveCount}</div><div class="stat-lbl">Currently Live</div></div>`;
    h+=`<div class="stat-card"><div class="stat-val">${(wl.users||[]).length}</div><div class="stat-lbl">Watchlist</div></div>`;
    h+=`</div>`;
    if(active.length>0){
      h+=`<h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px"><svg class="cr-icon" style="color:var(--red)"><use href="#i-live"/></svg> Recording Now</h3><div class="card-box" style="margin-bottom:20px">`;
      active.forEach(r=>{h+=`<div class="lcard"><div class="lcard-av">${avatarImg(r.username)}</div><div class="lcard-info"><div class="lcard-name">@${r.username}</div><div class="lcard-meta"><span class="badge badge-rec"><svg class="cr-icon" style="width:10px;height:10px;margin-right:3px"><use href="#i-rec"/></svg> REC</span><span class="timer" data-started="${r.startedAt}">${fmtDur(r.durationSeconds)}</span></div></div><div style="display:flex;gap:6px"><button class="btn btn-accent" onclick="playLive('${r.username}')"><svg class="btn-svg"><use href="#i-play"/></svg> Live</button><button class="btn btn-red" onclick="stopRec('${r.username}')"><svg class="btn-svg"><use href="#i-stop"/></svg> Stop</button></div></div>`});
      h+=`</div>`;
    }
    if(uploads.length>0){
      h+=`<h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px"><span class="spinner-sm"></span> Uploading Now</h3><div class="card-box">`;
      uploads.forEach(up=>{
        const match = up.match(/^TK_(.+?)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
        const name = match ? match[1] : 'creator';
        h+=`<div class="lcard"><div class="lcard-av">${avatarImg(name)}</div><div class="lcard-info"><div class="lcard-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px">${up}</div><div class="lcard-meta"><span class="badge badge-upload" style="background:rgba(255,165,0,0.15);color:orange;border:1px solid rgba(255,165,0,0.3)"><span class="pulse-orange"></span>UPLOADING</span></div></div></div>`
      });
      h+=`</div>`;
    }
    el.innerHTML=h;
  }catch{el.innerHTML=empty('⚠️','Failed to load')}
}

// ── LIBRARY ──
async function loadLibrary(){
  const el=$('#library-content');el.innerHTML=ld();
  try{
    const[wl,lr]=await Promise.all([fetch(API+'/api/watchlist').then(r=>r.json()),fetch(API+'/api/live').then(r=>r.json())]);
    const users=wl.users||[],lm={};(lr.users||[]).forEach(u=>{lm[u.username]=u});
    if(!users.length){el.innerHTML=empty('📚','No creators in your library yet');return}
    let h='<div class="card-box">';
    users.forEach(u=>{
      const info=lm[u],live=info&&info.isLive,rec=info&&info.isRecording;
      const badge=rec?'<span class="badge badge-rec"><svg class="cr-icon" style="width:10px;height:10px;margin-right:3px"><use href="#i-rec"/></svg> REC</span>':live?'<span class="badge badge-live"><span class="dot"></span>LIVE</span>':'<span class="badge badge-off">Offline</span>';
      h+=`<div class="cr-item" id="cr-item-${u}">
        <div class="cr-row" onclick="toggleExpand('${u}')">
          <button class="cr-expand" onclick="event.stopPropagation(); toggleExpand('${u}')"><svg class="cr-icon"><use href="#i-chev"/></svg></button>
          <div class="cr-avatar">${avatarImg(u)}</div>
          <div class="cr-info"><div class="cr-name">${u} ${badge}</div><div class="cr-meta">@${u}</div></div>
          <div class="cr-actions" onclick="event.stopPropagation()">
            ${live&&!rec?`<button class="btn-icon" onclick="startRec('${u}')" title="Record" style="color:var(--green)"><svg class="cr-icon"><use href="#i-rec"/></svg></button>`:''}
            ${rec?`<button class="btn-icon" onclick="stopRec('${u}')" title="Stop" style="color:var(--red)"><svg class="cr-icon"><use href="#i-stop"/></svg></button>`:''}
            <button class="btn-icon" onclick="window.open('https://www.tiktok.com/@${u}','_blank')" title="TikTok"><svg class="cr-icon"><use href="#i-link"/></svg></button>
            <button class="btn-icon" onclick="removeWatch('${u}')" title="Remove" style="color:var(--red)"><svg class="cr-icon"><use href="#i-trash"/></svg></button>
          </div>
        </div>
        <div class="cr-recordings" id="cr-recs-${u}"></div>
      </div>`;
    });
    h+='</div>';
    el.innerHTML=h;
  }catch{el.innerHTML=empty('⚠️','Failed to load library')}
}

async function toggleExpand(username){
  const item=document.getElementById(`cr-item-${username}`);
  const recsBox=document.getElementById(`cr-recs-${username}`);
  if(!item||!recsBox)return;
  const isExpanded=item.classList.toggle('expanded');
  if(isExpanded){
    recsBox.innerHTML=ld();
    try{
      const res=await fetch(`${API}/api/recordings/${username}`).then(r=>r.json());
      const recs=res.recordings||[];
      if(!recs.length){recsBox.innerHTML=empty('📹','No recordings found for this creator.');return}
      recsBox.innerHTML=`<div class="cr-rec-grid">`+recs.map(r=>`
        <div class="vcard" onclick="playVideo('${r.driveFileId||''}', '${r.messageId||''}', '${r.filename}')">
          <div class="vcard-thumb">
            <img src="${API}${r.thumb}" loading="lazy" onerror="this.style.display='none'">
            <div class="vcard-play"></div>
            <span class="vcard-dur">${fmtDur(r.duration)}</span>
          </div>
          <div class="vcard-body">
            <div class="vcard-date" style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${fmtDate(r.date)}</div>
            <div class="vcard-date" style="font-size:11px;color:var(--text2);margin-top:2px">${fmtSize(r.sizeMB)}</div>
          </div>
        </div>
      `).join('')+`</div>`;
    }catch{recsBox.innerHTML=empty('⚠️','Failed to load recordings')}
  }
}

// ── RECORDINGS ──
async function loadRecordings(){
  const el=$('#rec-content');el.innerHTML=ld();
  try{
    const res=await fetch(API+'/api/recordings').then(r=>r.json());
    const recs=res.recordings||[];
    if(!recs.length){el.innerHTML=empty('📹','No recordings yet');return}
    el.innerHTML='<div class="vid-grid">'+recs.map(r=>`<div class="vcard" onclick="playVideo('${r.driveFileId||''}', '${r.messageId||''}', '${r.filename}')"><div class="vcard-thumb"><img src="${API}${r.thumb}" loading="lazy" onerror="this.style.display='none'"><div class="vcard-play"></div><span class="vcard-dur">${fmtDur(r.duration)}</span></div><div class="vcard-body"><div class="vcard-user">@${r.username}</div><div class="vcard-date">${fmtDate(r.date)} · ${fmtSize(r.sizeMB)}</div></div></div>`).join('')+'</div>';
  }catch{el.innerHTML=empty('⚠️','Failed to load')}
}

// ── LIVE ──
async function loadLive(){
  const el=$('#live-content');el.innerHTML=ld();
  try{
    const[sr,lr]=await Promise.all([fetch(API+'/api/status').then(r=>r.json()),fetch(API+'/api/live').then(r=>r.json())]);
    const active=sr.activeRecordings||[];
    const liveNotRec=(lr.users||[]).filter(u=>u.isLive&&!u.isRecording);
    let h='';
    if(active.length){
      h+=`<h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px"><svg class="cr-icon" style="color:var(--red)"><use href="#i-live"/></svg> Recording</h3><div class="card-box" style="margin-bottom:20px">`;
      active.forEach(r=>{h+=`<div class="lcard"><div class="lcard-av">${avatarImg(r.username)}</div><div class="lcard-info"><div class="lcard-name">@${r.username}</div><div class="lcard-meta"><span class="badge badge-rec"><svg class="cr-icon" style="width:10px;height:10px;margin-right:3px"><use href="#i-rec"/></svg> REC</span><span class="timer" data-started="${r.startedAt}">${fmtDur(r.durationSeconds)}</span></div></div><div style="display:flex;gap:6px"><button class="btn btn-accent" onclick="playLive('${r.username}')"><svg class="btn-svg"><use href="#i-play"/></svg> Live</button><button class="btn btn-red" onclick="stopRec('${r.username}')"><svg class="btn-svg"><use href="#i-stop"/></svg> Stop</button></div></div>`});
      h+=`</div>`;
    }
    if(liveNotRec.length){
      h+=`<h3 style="font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px"><svg class="cr-icon" style="color:var(--green)"><use href="#i-live"/></svg> Live Now</h3><div class="card-box">`;
      liveNotRec.forEach(u=>{h+=`<div class="lcard"><div class="lcard-av">${avatarImg(u.username)}</div><div class="lcard-info"><div class="lcard-name">@${u.username}</div><div class="lcard-meta"><span class="badge badge-live"><span class="dot"></span>LIVE</span></div></div><button class="btn btn-accent" onclick="startRec('${u.username}')"><svg class="btn-svg"><use href="#i-rec"/></svg> Record</button></div>`});
      h+=`</div>`;
    }
    if(!active.length&&!liveNotRec.length)h=empty('😴','No one is live right now');
    el.innerHTML=h;
  }catch{el.innerHTML=empty('⚠️','Failed to load')}
}

// ── SEARCH ──
let st;
function initSearch(){
  const inp=$('#search-input');
  if(!inp)return;
  inp.addEventListener('input',e=>{clearTimeout(st);const v=e.target.value.trim();if(!v){$('#search-results').innerHTML='';return}st=setTimeout(()=>searchUser(v),600)});
}
function searchExample(u){$('#search-input').value=u;searchUser(u)}
async function searchUser(u){
  const el=$('#search-results');el.innerHTML=ld();
  try{
    const d=await fetch(API+'/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(r=>r.json());
    if(!d.exists){el.innerHTML=empty('🔍',`"${u}" not found on TikTok`);return}
    const badge=d.isLive?'<span class="badge badge-live"><span class="dot"></span>LIVE</span>':'<span class="badge badge-off">Offline</span>';
    el.innerHTML=`<div class="card-box"><div class="cr-row" style="cursor:default"><div class="cr-avatar">${avatarImg(d.username)}</div><div class="cr-info"><div class="cr-name">${d.username} ${badge}</div><div class="cr-meta">@${d.username}</div></div><div class="cr-actions"><button class="btn btn-accent" onclick="addWatch('${d.username}')"><svg class="btn-svg"><use href="#i-plus"/></svg> Add</button>${d.isLive?`<button class="btn btn-green" onclick="startRec('${d.username}')"><svg class="btn-svg"><use href="#i-rec"/></svg> Record</button>`:''}<button class="btn-icon" onclick="window.open('https://www.tiktok.com/@${d.username}','_blank')"><svg class="cr-icon"><use href="#i-link"/></svg></button></div></div></div>`;
  }catch{el.innerHTML=empty('⚠️','Search failed')}
}

// ── ACTIONS ──
async function syncDriveStreams() {
  const btn = $('button[onclick="syncDriveStreams()"]');
  if(btn){
    btn.disabled=true;
    btn.innerHTML=`<span class="spinner-sm"></span> Syncing...`;
  }
  toast('🔄 Retrieving Drive recordings...');
  try{
    const res = await fetch(API+'/api/drive/sync',{method:'POST'}).then(r=>r.json());
    if(res.success){
      toast(`✅ Retrieved! Added ${res.added} new, updated ${res.updated} streams.`);
      if(currentPage==='library') loadLibrary();
    } else {
      toast('❌ Retrieve failed: '+(res.error||'Unknown'));
    }
  } catch {
    toast('❌ Retrieve request failed');
  } finally {
    if(btn){
      btn.disabled=false;
      btn.innerHTML=`<svg class="btn-svg"><use href="#i-sync"/></svg> Retrieve`;
    }
  }
}

async function startRec(u){try{await fetch(API+'/api/rec/'+u,{method:'POST'});toast('🔴 Recording '+u);setTimeout(()=>{loadDashboard();loadLive();loadLibrary()},1000)}catch{toast('❌ Failed')}}
async function stopRec(u){try{await fetch(API+'/api/stop/'+u,{method:'POST'});toast('⏹ Stopped '+u);setTimeout(()=>{loadDashboard();loadLive()},500)}catch{toast('❌ Failed')}}
async function addWatch(u){try{await fetch(API+'/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})});toast('✅ Added @'+u);loadLibrary()}catch{toast('❌ Failed')}}
async function removeWatch(u){try{await fetch(API+'/api/watchlist/'+u,{method:'DELETE'});toast('🗑 Removed @'+u);loadLibrary()}catch{toast('❌ Failed')}}

let livePlayer=null;
function playVideo(driveId, msgId, f){
  const m=$('#modal'),v=$('#modal-video');
  // Use Google Drive for streaming, fall back to local storage (Telegram is meant to be exclusively on Telegram)
  if(driveId && driveId!=='undefined' && driveId!==''){
    v.src=API+'/api/drive/video/'+driveId;
  } else {
    v.src=API+'/recordings/'+f;
  }
  m.classList.add('open');v.play();
}
function playLive(u){
  const m=$('#modal'),v=$('#modal-video');
  m.classList.add('open');
  if(window.mpegts && mpegts.getFeatureList().mseLivePlayback){
    livePlayer=mpegts.createPlayer({type:'flv',isLive:true,url:API+'/api/stream/'+u});
    livePlayer.attachMediaElement(v);
    livePlayer.load();
    livePlayer.play();
  } else { toast('Live playback not supported'); }
}
function closeModal(){
  const m=$('#modal'),v=$('#modal-video');
  if(livePlayer){livePlayer.destroy();livePlayer=null;}
  v.pause();v.src='';m.classList.remove('open');
}
$('#modal').addEventListener('click',e=>{if(e.target.classList.contains('modal'))closeModal()});

// Timers
setInterval(()=>{$$('.timer[data-started]').forEach(el=>{const s=Math.round((Date.now()-new Date(el.dataset.started).getTime())/1000);el.textContent=fmtDur(s)})},1000);
setInterval(()=>{if(currentPage==='dashboard'||currentPage==='live')loadDashboard()},15000);

// Telegram
try{const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand()}}catch{}

// Init
initSearch();
loadDashboard();
