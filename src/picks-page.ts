export function renderPicksPage(token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Weekend picks</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8ee;--muted:#8b93a7;--accent:#7aa2f7;--border:#262a36;--ok:#2ecc71;--bad:#ff5c5c}
@media(prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--fg:#1c1f2a;--muted:#5f677a;--border:#e2e5ee}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px 16px 80px;max-width:720px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;color:var(--muted);margin:24px 0 8px;font-weight:500}
.pick{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:10px 0}
.pick .t{font-weight:600;font-size:17px}.pick .m{color:var(--muted);font-size:13.5px;margin:2px 0 6px}.pick .w{font-size:14.5px}.pick a{color:var(--accent);font-size:13.5px}
.row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
button{font:inherit;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:999px;padding:6px 14px;cursor:pointer}
button.on.up{border-color:var(--ok);color:var(--ok)}button.on.down{border-color:var(--bad);color:var(--bad)}
input,textarea{font:inherit;width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:8px}
.why{display:none;margin-top:8px}.why.show{display:block}
.fb{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:24px}
.muted{color:var(--muted);font-size:13.5px}.ok{color:var(--ok)}
</style></head><body>
<h1>Weekend picks</h1><div class="muted">Tap 👍 or 👎 on a pick. Ratings go straight into the scout's memory and the manager's inbox. <a href="/" style="color:var(--accent)">status page</a></div>
<div id="sets"><p class="muted">loading…</p></div>
<div class="fb"><b>Tell the manager</b><div class="muted" style="margin-bottom:8px">Plain language: "more outdoors", "we're only free Oct 11", "pause the scout for two weeks".</div>
<textarea id="fbtext" rows="3" placeholder="…"></textarea><div class="row"><button id="fbsend">Send to manager</button><span id="fbmsg" class="muted"></span></div></div>
<script>
const K=${JSON.stringify(token)};
const api=(p,o={})=>fetch(p+(p.includes('?')?'&':'?')+'k='+encodeURIComponent(K),{headers:{'content-type':'application/json'},...o}).then(r=>r.json());
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){
  const sets=await api('/api/picks');
  const el=document.getElementById('sets');
  if(!sets.length){el.innerHTML='<p class="muted">No picks yet. The scout delivers Wednesday evening and Friday noon.</p>';return}
  el.innerHTML=sets.map(s=>'<h2>'+esc(s.note.title)+' <span class="muted">· '+new Date(s.note.ts).toLocaleString()+'</span></h2>'+s.picks.map(p=>
    '<div class="pick" data-id="'+p.id+'"><div class="t">'+esc(p.title)+'</div><div class="m">'+esc(p.when_start||'')+(p.place?' · '+esc(p.place):'')+(p.price!=null?' · $'+p.price:'')+(p.category?' · '+esc(p.category):'')+'</div>'+
    (p.why?'<div class="w">'+esc(p.why)+'</div>':'')+(p.summary?'<div class="muted">'+esc(p.summary)+'</div>':'')+'<a href="'+esc(p.url)+'" target="_blank" rel="noopener">open link ↗</a>'+
    '<div class="row"><button class="up'+(p.rating==='up'?' on':'')+'" data-r="up">👍</button><button class="down'+(p.rating==='down'?' on':'')+'" data-r="down">👎</button><span class="muted msg">'+(p.rating_reason?esc(p.rating_reason):'')+'</span></div>'+
    '<div class="why"><input placeholder="why? (optional, Enter to send)"></div></div>').join('')).join('');
  el.querySelectorAll('button[data-r]').forEach(b=>b.onclick=async()=>{
    const card=b.closest('.pick');const id=Number(card.dataset.id);const r=b.dataset.r;
    card.querySelectorAll('button[data-r]').forEach(x=>x.classList.remove('on'));b.classList.add('on');
    const why=card.querySelector('.why');why.classList.add('show');const inp=why.querySelector('input');inp.focus();
    await api('/api/picks/rate',{method:'POST',body:JSON.stringify({candidateId:id,rating:r})});
    card.querySelector('.msg').textContent='saved';
    inp.onkeydown=async e=>{if(e.key==='Enter'&&inp.value.trim()){await api('/api/picks/rate',{method:'POST',body:JSON.stringify({candidateId:id,rating:r,reason:inp.value.trim()})});card.querySelector('.msg').textContent='saved: '+inp.value.trim();why.classList.remove('show')}};
  });
}
document.getElementById('fbsend').onclick=async()=>{const t=document.getElementById('fbtext');if(!t.value.trim())return;const r=await api('/api/picks/feedback',{method:'POST',body:JSON.stringify({text:t.value.trim()})});document.getElementById('fbmsg').textContent=r.ok?'sent — the manager reads it on its next run':'error';if(r.ok)t.value=''};
load();
</script></body></html>`;
}
