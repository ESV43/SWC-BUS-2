/* SWC Bus Slip — live booking app (Google Sheets backend only) */
(function(){
  const CFG = window.SWC_CONFIG || {};
  const API = (CFG.APPS_SCRIPT_URL || "").trim();
  const DOMAIN = CFG.ALLOWED_DOMAIN || "@iisertvm.ac.in";
  const $ = (id) => document.getElementById(id);
  const cardsEl = $("serviceCards"), countdownEl = $("countdown"), modeBadge = $("modeBadge");
  let services = [];
  let timer = null;
  let user = null;
  try { user = JSON.parse(localStorage.getItem("swc_user") || "null"); } catch(e){ user=null; }
  // Drop restored sessions that are not IISER or whose Google token already expired
  try{
    if(user && (!user.email || String(user.email).toLowerCase().indexOf(DOMAIN)===-1)) user=null;
    if(user && user.idToken){
      const pay=JSON.parse(atob(user.idToken.split(".")[1]));
      if(pay.exp && pay.exp*1000 < Date.now()){ user=null; try{localStorage.removeItem("swc_user");}catch(e){} }
    } else if(user && !user.idToken){ user=null; try{localStorage.removeItem("swc_user");}catch(e){} }
  }catch(e){ user=null; }

  const pad = (n)=>String(n).padStart(2,"0");
  const fmtD = (iso)=>{ const p=String(iso).split("-").map(Number); return new Date(p[0],p[1]-1,p[2]).toLocaleDateString("en-IN",{weekday:"short",day:"numeric",month:"short"}); };
  const esc = (s)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  function toast(msg, type=""){ const t=document.createElement("div"); t.className="toast "+type; t.textContent=msg; $("toasts").appendChild(t); setTimeout(()=>t.remove(),4500); }
  function showModal(title, body){ $("modalTitle").textContent=title; $("modalBody").innerHTML=body; $("modal").classList.remove("hidden"); }
  $("modalClose").onclick=()=>$("modal").classList.add("hidden");
  $("modal").addEventListener("click",(e)=>{ if(e.target.id==="modal") $("modal").classList.add("hidden"); });

  /* backend not configured → stop with a clear message */
  if (API.length < 10) {
    modeBadge.textContent = "⚠ SETUP NEEDED";
    modeBadge.classList.remove("live");
    cardsEl.innerHTML = `<p class="hint">Booking backend is not connected yet. Please ask the SWC admin to set the booking server URL and reload.</p>`;
    countdownEl.textContent = "backend not connected";
    $("bookBtn").disabled = true;
    toast("Backend URL missing in config.js", "err");
    initAuth();
    return;
  }
  modeBadge.textContent = "● LIVE";
  modeBadge.classList.add("live");

  async function apiGet(params){
    const u=API+(API.includes("?")?"&":"?")+new URLSearchParams(params).toString();
    const r=await fetch(u); return r.json();
  }
  async function apiPost(body){
    const r=await fetch(API,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(body)});
    return r.json();
  }

  async function loadServices(){
    try{
      const j=await apiGet({action:"services"});
      if(!j.ok) throw new Error(j.error||"server error");
      services=j.services||[];
    }catch(e){
      cardsEl.innerHTML = `<p class="hint">⚠️ Couldn't reach the booking server (${esc(e.message)}). Check your connection and <a href="#" onclick="location.reload();return false;">retry</a>.</p>`;
      return;
    }
    render();
  }

  function shortDT(isoStr){
    try{
      const d=new Date(isoStr);
      return d.toLocaleDateString("en-IN",{day:"2-digit",month:"short"}).toUpperCase()
        + ", " + d.toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit"}).toUpperCase();
    }catch(e){ return ""; }
  }
  function stamp(s){
    if(s.disabled) return `<span class="stamp off">OFF</span>`;
    if(s.window==="upcoming") return `<span class="stamp soon">OPENS ${esc(shortDT(s.opensISO)||s.opensAt)}</span>`;
    if(s.window==="closed") return `<span class="stamp off">GONE</span>`;
    if(s.available<=0) return `<span class="stamp full">FULL</span>`;
    return `<span class="stamp open">OPEN</span>`;
  }

  function render(){
    cardsEl.innerHTML=services.map(s=>{
      const pct=Math.min(100,Math.round(s.confirmedCount/s.totalSeats*100));
      const title=s.kind==="special"?esc(s.serviceName):String(s.day||"").slice(0,3).toUpperCase();
      const timeOnly=esc(String(s.departure).split(" ").pop());
      const busTime=`${fmtD(s.serviceDate)} · ${timeOnly}`;
      const routeLine=`${esc(s.from)} → ${esc(s.to)}`;
      const bookingLine=s.disabled?("Off"+(s.disableReason?": "+esc(s.disableReason):""))
        : s.window==="upcoming"?("Opens "+esc(s.opensAt)+" → Closes "+esc(s.closesAt))
        : s.window==="closed"?("Closed "+esc(s.closesAt))
        : s.available>0?(`${s.waitlistCount? s.waitlistCount+" on waitlist · ":""}Closes ${timeOnly}`)
        :(`All ${s.totalSeats} filled`+(s.waitlistCount?` · ${s.waitlistCount} waiting`:" — join waitlist"));
      const can=s.bookingOpen;
      const btn=s.disabled?"NOT OPERATING":s.window==="upcoming"?"OPENS "+esc(s.opensAt):s.window==="closed"?"BOOKING CLOSED":s.available>0?"BOOK THIS BUS":"JOIN WAITLIST";
      return `<div class="bus ${s.disabled?"off":""} ${s.available<=0&&!s.disabled?"full":""}">
        <div class="bus-top"><div><div class="bus-day">${title}</div></div>${stamp(s)}</div>
        <div class="bus-lines">
          <div><span>BUS TIME:</span> <strong>${busTime}</strong></div>
          <div><span>ROUTE:</span> <strong>${routeLine}</strong></div>
          <div><span>BOOKING TIME:</span> <strong>${bookingLine}</strong></div>
        </div>
        <div class="seat-big">${s.disabled?"–":s.available}<small> / ${s.totalSeats} left</small></div>
        <div class="meter"><i style="width:${s.disabled?0:pct}%"></i></div>
        <button class="pick" ${can?"":"disabled"} onclick="window._prefill('${esc(s.serviceId)}')">${btn}</button>
      </div>`;
    }).join("") || `<p class="hint">No upcoming buses right now — check back soon.</p>`;
    $("fService").innerHTML=services.map(s=>`<option value="${esc(s.serviceId)}">${s.kind==="special"?esc(s.serviceName)+" · ":""}${String(s.day||"").slice(0,3)} ${fmtD(s.serviceDate)} — ${s.disabled?"off":s.available<=0?"full · waitlist":s.available+" left"}</option>`).join("");
    tick();
  }
  window._prefill=(sid)=>{ $("fService").value=sid; $("bookForm").scrollIntoView({behavior:"smooth",block:"center"}); };

  function shortDay(s){ return s.kind==="special"?s.serviceName:String(s.day||"").slice(0,3); }
  function tick(){
    if(!services.length) return;
    const now=new Date();
    let ev=null;
    for(const s of services){
      if(s.disabled||!s.opensISO||!s.closesISO) continue;
      const opens=new Date(s.opensISO), closes=new Date(s.closesISO), dep=new Date(s.departISO||s.closesISO);
      if(now<opens){ ev={t:opens,label:`${shortDay(s)} booking opens in`}; break; }
      if(now<=closes){ ev={t:closes,label:`${shortDay(s)} booking closes in`}; break; }
      if(now<=dep){ ev={t:dep,label:`${shortDay(s)} bus leaves in`}; break; }
    }
    if(!ev){ countdownEl.textContent="No upcoming buses right now — check back soon."; return; }
    const ms=ev.t-now; if(ms<0){countdownEl.textContent="updating…";return;}
    const h=Math.floor(ms/36e5),m=Math.floor(ms%36e5/6e4),sec=Math.floor(ms%6e4/1e3);
    countdownEl.textContent=`⏳ ${ev.label} ${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  timer=setInterval(tick,1000);

  /* auth — Google Identity Services, IISER domain enforced.
     Email is NEVER typed: it comes only from the verified Google ID token. */
  function initAuth(){
    lockEmailField();
    paintUser();
    const cid=(CFG.GOOGLE_CLIENT_ID||"").trim();
    if(!cid){
      $("loginBtn").onclick=()=>toast("Google sign-in is not configured yet. Booking needs Google login.","err");
      $("formMsg").className="form-msg err";
      $("formMsg").textContent="Google sign-in is not configured — booking disabled.";
      $("bookBtn").disabled=true;
      return;
    }
    let ready=false;
    const boot=()=>{
      try{
        google.accounts.id.initialize({client_id:cid,callback:onCred,hd:"iisertvm.ac.in",auto_select:false});
        google.accounts.id.renderButton($("gBtnWrap"),{theme:"outline",size:"large",text:"signin_with",shape:"rectangular"});
        ready=true;
      }catch(e){ setTimeout(boot,800); }
    };
    boot();
    $("loginBtn").onclick=()=>{ try{google.accounts.id.prompt();}catch(e){ if(!ready) toast("Google sign-in still loading…","err"); } };
  }
  /* Hard-lock the email input: readonly in HTML + JS guards against paste/drop/autofill tampering */
  function lockEmailField(){
    const el=$("fEmail");
    if(!el) return;
    el.setAttribute("readonly","");
    el.setAttribute("aria-readonly","true");
    el.setAttribute("autocomplete","off");
    ["paste","drop","keydown","keypress","beforeinput"].forEach(ev=>el.addEventListener(ev,(e)=>{
      // allow Tab navigation only; block any value change
      if(e.type==="keydown" && (e.key==="Tab"||e.key==="Escape")) return;
      e.preventDefault();
    }));
    el.addEventListener("focus",()=>el.blur());
  }
  function onCred(resp){
    try{
      const payload=JSON.parse(atob(resp.credential.split(".")[1]));
      const email=(payload.email||"").toLowerCase().trim();
      if(payload.hd && payload.hd.toLowerCase()!=="iisertvm.ac.in"){ toast("Only @iisertvm.ac.in IDs can book.","err"); return; }
      if(!email.endsWith(DOMAIN)){ toast("Only "+DOMAIN+" IDs can book. Signed in as "+email,"err"); return; }
      if(payload.email_verified===false){ toast("Google email not verified. Use a verified @iisertvm.ac.in ID.","err"); return; }
      user={name:payload.name||email.split("@")[0],email,idToken:resp.credential};
      try{localStorage.setItem("swc_user",JSON.stringify(user));}catch(e){}
      paintUser();
      if(!$("fName").value&&payload.name) $("fName").value=payload.name;
      toast("Verified "+email,"ok");
      loadMy();
    }catch(e){ toast("Sign-in failed.","err"); }
  }
  function paintUser(){
    const has=!!(user&&user.email);
    $("loginBtn").classList.toggle("hidden",has);
    $("userChip").classList.toggle("hidden",!has);
    if(has){
      $("userEmail").textContent=user.email;
      $("fEmail").value=user.email; // auto-fill only, never typed
      $("authGate").classList.add("hidden");
      $("myAuthHint").textContent="Signed in as "+user.email+" — showing your bookings.";
    }else{
      $("fEmail").value="";
      $("authGate").classList.remove("hidden");
      $("myAuthHint").textContent="🔒 Sign in with Google above to see / cancel your bookings. Email lookup is disabled — bookings load only from your signed-in ID.";
      $("myList").innerHTML=`<p class="hint">Not signed in.</p>`;
    }
  }
  $("logoutBtn").onclick=()=>{ user=null; try{localStorage.removeItem("swc_user");}catch(e){} try{google.accounts.id.disableAutoSelect();}catch(e){} paintUser(); };

  /* book — email comes ONLY from Google login, never from the input */
  $("bookForm").addEventListener("submit",async(e)=>{
    e.preventDefault();
    const msg=$("formMsg"); msg.className="form-msg"; msg.textContent="";
    if(!user||!user.email||!user.idToken){
      msg.className="form-msg err"; msg.textContent="Please sign in with your @iisertvm.ac.in Google account first.";
      toast("Google sign-in required.","err");
      return;
    }
    const serviceId=$("fService").value;
    const svc=services.find(x=>x.serviceId===serviceId) || {};
    const name=$("fName").value.trim(), phone=$("fPhone").value.trim();
    const email=user.email.toLowerCase(); // authoritative source — ignore anything in #fEmail
    $("fEmail").value=email; // re-sync in case DevTools tampered with it
    if(!email.endsWith(DOMAIN)){ msg.className="form-msg err"; msg.textContent="Only "+DOMAIN+" IDs can book. You are signed in as "+email+"."; return; }
    $("bookBtn").disabled=true; $("bookBtn").textContent="BOOKING…";
    try{
      const j=await apiPost({action:"book",serviceId,serviceDate:svc.serviceDate,name,email,phone,idToken:user.idToken});
      if(!j.ok) throw new Error(j.error);
      const tag=svc.serviceName?esc(svc.serviceName)+" · ":"";
      if(j.status==="CONFIRMED"){
        msg.className="form-msg ok"; msg.textContent="Booked! Mail sent to "+email;
        showModal("Seat booked ✅",`Hi <b>${esc(name)}</b> — ${tag}<b>${esc(svc.serviceDate||"")}</b> confirmed.<br><br>ID: <b>${esc(j.bookingId)}</b><br>Mail from <b>SWC.IISER.TVM</b> sent to <b>${esc(email)}</b>.<br>Be ready 15 min early with college ID.`);
      }else{
        msg.className="form-msg ok"; msg.textContent=`All ${svc.totalSeats||""} filled — waitlist #${j.waitlistPosition}`;
        showModal("Waitlist #"+j.waitlistPosition,`Sorry, all seats are filled.<br><br>You are <b>#${esc(j.waitlistPosition)}</b> for ${tag}<b>${esc(svc.serviceDate||"")}</b> (ID <b>${esc(j.bookingId)}</b>).<br>Auto-confirm + mail if someone cancels.`);
      }
      loadServices(); loadMy();
    }catch(err){
      msg.className="form-msg err"; msg.textContent=err.message; toast(err.message,"err");
      if(/sign-in|token|expired|login/i.test(err.message||"")) paintUser();
    }
    finally{ $("bookBtn").disabled=false; $("bookBtn").textContent="BOOK SEAT →"; }
  });

  /* my bookings — no manual email entry; loads only the signed-in user's bookings */
  async function loadMy(){
    const box=$("myList");
    if(!user||!user.email||!user.idToken){ box.innerHTML=`<p class="hint">Not signed in.</p>`; return; }
    const email=user.email.toLowerCase();
    box.innerHTML=`<p class="hint">Loading…</p>`;
    let list=[];
    try{
      const j=await apiPost({action:"mybookings",email,idToken:user.idToken});
      if(!j.ok) throw new Error(j.error);
      list=j.bookings;
    }catch(e){ box.innerHTML=`<p class="hint">⚠️ ${esc(e.message)}</p>`; return; }
    if(!list.length){ box.innerHTML=`<p class="hint">No bookings for <b>${esc(email)}</b>.</p>`; return; }
    box.innerHTML=list.map(b=>{
      const nm=b.serviceName||b.day||"";
      const dep=b.departure||b.serviceDate||"";
      return `<div class="ticket-row">
      <div><strong>${esc(nm)} · ${esc(dep)}</strong><br><span class="id">${esc(b.bookingId)}${b.seatNo?" · seat "+esc(b.seatNo):""}${b.waitlistPosition?" · WL #"+esc(b.waitlistPosition):""}</span></div>
      <div style="display:flex;gap:8px;align-items:center"><span class="pill ${b.status}">${b.status}</span>
      ${(b.status==="CONFIRMED"||b.status==="WAITLIST")?`<button class="cancel" onclick="window._cancel('${b.bookingId}')">Cancel</button>`:""}</div>
    </div>`;}).join("");
  }
  window._cancel=async(id)=>{
    if(!user||!user.email||!user.idToken){ toast("Please sign in first.","err"); return; }
    const email=user.email.toLowerCase();
    if(!confirm("Cancel "+id+"? Seat goes to the waitlist.")) return;
    try{
      const j=await apiPost({action:"cancel",bookingId:id,email,idToken:user.idToken});
      if(!j.ok) throw new Error(j.error);
      toast(j.message,"ok"); showModal("Cancelled",esc(j.message)+"<br><br>Mail sent by <b>SWC.IISER.TVM</b>.");
    }catch(e){ toast(e.message,"err"); }
    loadServices(); loadMy();
  };

  initAuth(); loadServices();
  if(user&&user.email) loadMy();
})();
