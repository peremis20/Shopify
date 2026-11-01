/** The Team Inbox page and its one time setup page. All text is set with textContent: no email HTML ever runs. */

const fonts =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';

const css = `
:root{--paper:#F3F4F7;--card:#FFFFFF;--ink:#1C2230;--muted:#5D6678;--line:#DCE0E8;--accent:#2443A8;--soft:#E6EBFA;--warn:#B4322A;--warnsoft:#F8E5E3;
--display:"Bricolage Grotesque","Segoe UI",system-ui,sans-serif;--body:"IBM Plex Sans",system-ui,-apple-system,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#12151C;--card:#1A1E28;--ink:#E7EAF2;--muted:#A0A8BA;--line:#2C3242;--accent:#8DA6FF;--soft:#232C4A;--warn:#FF8A80;--warnsoft:#3A2224;color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 var(--body)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px max(16px,env(safe-area-inset-left,0px)) 12px max(16px,env(safe-area-inset-right,0px));border-bottom:1px solid var(--line);background:var(--card)}
h1{font:700 22px/1 var(--display);margin:0}h2{font:700 16px/1.2 var(--display);margin:0 0 8px}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr) minmax(0,1.3fr);height:calc(100% - 59px)}
@media (max-width:980px){.wrap{grid-template-columns:minmax(0,1fr);height:auto}}
.col{min-width:0;overflow:auto;padding:14px 16px;border-right:1px solid var(--line)}
.col:last-child{border-right:0;background:var(--card)}
button,.btn{font:600 13.5px var(--body);border-radius:8px;padding:7px 12px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--accent)}button:disabled{opacity:.6;cursor:default}
.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.inboxes{list-style:none;margin:10px 0;padding:0;display:grid;gap:6px}
.inboxes button{width:100%;text-align:left;display:grid;gap:2px}
.inboxes button[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.addr{font-size:13.5px;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:12.5px}
.err{color:var(--warn);font-size:12.5px}
.list{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.msg{width:100%;text-align:left;display:grid;gap:2px;padding:9px 11px}
.msg.unread .subj{font-weight:600}.msg.unread{border-left:3px solid var(--accent)}
.msg[aria-current=true]{border-color:var(--accent)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.spread{justify-content:space-between}
.tag{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--accent);overflow-wrap:anywhere}
.subj,.from{overflow-wrap:anywhere}.snip{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mail{border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:10px}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px;font-size:14px}
textarea,input{width:100%;font:14px var(--body);color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:9px 10px}
textarea{min-height:140px;resize:vertical}
.notice{padding:9px 12px;border-radius:8px;background:var(--soft);margin:10px 16px 0}.notice.bad{background:var(--warnsoft);color:var(--warn)}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:14px;margin-top:10px}
.center{max-width:560px;margin:10vh auto;padding:0 max(16px,env(safe-area-inset-left,0px)) 0 max(16px,env(safe-area-inset-right,0px))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;display:grid;gap:12px}
label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
`;

export function appHtml(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Team Inbox</title>${fonts}<style>${css}</style></head><body>
<div id="app"><div class="center"><p class="meta">Opening Team Inbox…</p></div></div>
<script nonce="${nonce}">${appScript}</script></body></html>`;
}

export function setupHtml(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Team Inbox setup</title>${fonts}<style>${css}</style></head><body>
<div class="center"><form class="card" id="f">
<h1>Set up Team Inbox</h1>
<p class="meta">Paste the login key from Google Cloud. The secret is stored encrypted and never shown again.</p>
<label>Client ID<input id="cid" autocomplete="off" required placeholder="1234-abc.apps.googleusercontent.com"></label>
<label>Client secret<input id="csec" type="password" autocomplete="off" required></label>
<label>Owner's email (signs in and adds the team)<input id="own" type="email" autocomplete="off" required></label>
<button class="primary" type="submit" id="go">Save and finish</button>
<p class="meta" id="msg" role="status"></p>
</form></div>
<script nonce="${nonce}">
document.getElementById("f").addEventListener("submit", async function (e) {
  e.preventDefault();
  var msg = document.getElementById("msg"), go = document.getElementById("go");
  var token = new URLSearchParams(location.search).get("token") || "";
  go.disabled = true; msg.textContent = "Saving…";
  try {
    var r = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json", "X-Team-Inbox": "1" },
      body: JSON.stringify({ token: token, clientId: cid.value, clientSecret: csec.value, owner: own.value }) });
    var d = await r.json();
    if (!r.ok) { msg.textContent = d.error || "Couldn't save."; go.disabled = false; return; }
    msg.textContent = "Done. Opening Team Inbox…"; location.href = "/";
  } catch (err) { msg.textContent = "Couldn't reach Team Inbox. Try again."; go.disabled = false; }
});
</script></body></html>`;
}

const appScript = `
(function(){
"use strict";
var $=function(id){return document.getElementById(id)};
function el(t,a,k){var n=document.createElement(t);if(a)for(var x in a){if(x==="text")n.textContent=a[x];else if(x==="class")n.className=a[x];else if(x.slice(0,2)==="on")n.addEventListener(x.slice(2),a[x]);else n.setAttribute(x,a[x]);}(k||[]).forEach(function(c){if(c)n.append(c)});return n}
var S={me:null,inboxes:[],messages:[],filter:null,unread:false,open:null,thread:null,loading:false};
async function api(p,b){var r=await fetch(p,b?{method:"POST",headers:{"Content-Type":"application/json","X-Team-Inbox":"1"},body:JSON.stringify(b)}:{});var d=await r.json().catch(function(){return{}});if(!r.ok)throw Object.assign(new Error(d.error||"Something went wrong."),{status:r.status});return d}
var when=function(ms){var d=new Date(ms),n=new Date();return d.toDateString()===n.toDateString()?d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}):d.toLocaleDateString([], {month:"short",day:"numeric"})};
var nameOf=function(h){var m=String(h||"").match(/^\\s*"?([^"<]+?)"?\\s*</);return m?m[1]:String(h||"")};
function notice(text,bad){var n=$("notice");if(!n)return;n.textContent=text||"";n.hidden=!text;n.className="notice"+(bad?" bad":"")}

async function boot(){
  // Messages come only from this app's own short lived cookie, never from the address bar.
  var note=null;document.cookie.split(";").forEach(function(c){var p=c.trim().split("=");if(p[0]==="__Host-ti_notice"){try{note=decodeURIComponent(p.slice(1).join("="))}catch(e){}}});
  if(note)document.cookie="__Host-ti_notice=; Path=/; Max-Age=0; Secure; SameSite=Lax";
  if(location.search)history.replaceState(null,"","/");
  var d=await api("/api/me").catch(function(){return null});
  if(!d){$("app").replaceChildren(el("div",{class:"center"},[el("p",{class:"err",text:"Team Inbox couldn't be reached. Reload to try again."})]));return}
  if(!d.setUp){$("app").replaceChildren(el("div",{class:"center"},[el("div",{class:"card"},[el("h1",{text:"Team Inbox"}),el("p",{text:"Not set up yet. Open the setup link you were given."})])]));return}
  if(!d.me){$("app").replaceChildren(el("div",{class:"center"},[el("div",{class:"card"},[el("h1",{text:"Team Inbox"}),el("p",{class:"meta",text:"All your team's inboxes in one place. Sign in with your Google account."}),note?el("p",{class:"notice",text:note}):null,el("a",{class:"btn primary",href:"/api/auth/login",text:"Sign in with Google"})])]));return}
  S.me=d.me;layout();if(note)notice(note,/isn't|cancel|expired|didn't|Please|first/i.test(note));load();
}

function layout(){
  $("app").replaceChildren(
    el("div",{class:"top"},[el("h1",{text:"Team Inbox"}),el("div",{class:"row"},[el("span",{class:"meta",text:S.me.email}),
      S.me.owner?el("button",{type:"button",text:"Team",onclick:showTeam}):null,
      el("button",{type:"button",text:"Sign out",onclick:async function(){await api("/api/auth/logout",{});location.href="/"}})])]),
    el("p",{id:"notice",class:"notice",hidden:""}),
    el("div",{class:"wrap"},[el("section",{class:"col",id:"left","aria-label":"Inboxes"}),el("section",{class:"col",id:"mid","aria-label":"Messages"}),el("section",{class:"col",id:"right","aria-label":"Open email"})]));
  renderLeft();renderMid();renderRight();
}

async function load(){
  S.loading=true;renderMid();
  try{var d=await api("/api/mail?"+new URLSearchParams(Object.assign({},S.unread?{unread:"1"}:{},S.filter?{inbox:S.filter}:{})));S.inboxes=d.inboxes;S.messages=d.messages}
  catch(e){if(e.status===401){location.href="/";return}notice(e.message,true)}
  S.loading=false;renderLeft();renderMid();
}

function renderLeft(){
  var L=$("left");if(!L)return;
  var items=[el("li",null,[el("button",{type:"button","aria-pressed":String(!S.filter),onclick:function(){S.filter=null;load()}},[el("span",{class:"addr",text:"All inboxes"})])])];
  S.inboxes.forEach(function(i){items.push(el("li",null,[el("button",{type:"button","aria-pressed":String(S.filter===i.id),onclick:function(){S.filter=i.id;load()}},[
    el("span",{class:"addr",text:i.address}),i.error?el("span",{class:"err",text:i.error}):null])]))});
  var hint=el("input",{id:"hint",type:"email",placeholder:"info@yourdomain.com","aria-label":"Address to connect"});
  L.replaceChildren(el("h2",{text:"Inboxes"}),
    S.inboxes.length?null:el("p",{class:"empty",text:"No inbox connected yet. Add one below; you'll sign in to it with Google."}),
    el("ul",{class:"inboxes"},items),
    el("label",{class:"meta",style:"margin-top:8px"},[el("span",{text:"Add an inbox"}),hint]),
    el("div",{class:"row",style:"margin-top:6px"},[el("button",{class:"primary",type:"button",text:"Connect with Google",onclick:function(){location.href="/api/auth/connect"+(hint.value?"?hint="+encodeURIComponent(hint.value.trim()):"")}})]),
    S.filter?el("p",{style:"margin-top:14px"},[el("button",{type:"button",text:"Remove this inbox",onclick:function(e){removeInbox(e.currentTarget)}})]):null);
}

function renderMid(){
  var M=$("mid");if(!M)return;
  var head=el("div",{class:"row spread"},[el("h2",{text:S.filter?(S.inboxes.find(function(i){return i.id===S.filter})||{}).address||"Inbox":"All inboxes"}),
    el("div",{class:"row"},[el("button",{type:"button","aria-pressed":String(S.unread),text:S.unread?"Showing unread":"Unread only",onclick:function(){S.unread=!S.unread;load()}}),el("button",{type:"button",text:"Refresh",onclick:load})])]);
  if(S.loading){M.replaceChildren(head,el("p",{class:"meta",text:"Loading mail…"}));return}
  if(!S.messages.length){M.replaceChildren(head,el("p",{class:"empty",text:S.inboxes.length?"Nothing here. Your inbox is clear.":"Connect an inbox to see its mail here."}));return}
  var addr={};S.inboxes.forEach(function(i){addr[i.id]=i.address});
  M.replaceChildren(head,el("ul",{class:"list"},S.messages.map(function(m){
    return el("li",null,[el("button",{type:"button",class:"msg"+(m.unread?" unread":""),"aria-current":String(S.open&&S.open.id===m.id),onclick:function(){openMsg(m)}},[
      el("span",{class:"row spread"},[el("span",{class:"from",text:nameOf(m.from)}),el("span",{class:"meta",text:when(m.date)})]),
      el("span",{class:"subj",text:m.subject+(m.count>1?"  ("+m.count+")":"")}),el("span",{class:"snip",text:m.snippet}),
      S.filter?null:el("span",null,[el("span",{class:"tag",text:addr[m.inboxId]||""})])])])})));
}

async function openMsg(m){
  S.open=m;S.thread=null;renderMid();renderRight();
  try{S.thread=await api("/api/thread?"+new URLSearchParams({inbox:m.inboxId,thread:m.threadId}));
    if(m.unread){api("/api/modify",{inbox:m.inboxId,thread:m.threadId,action:"read"}).then(function(){m.unread=false;renderMid()}).catch(function(){})}}
  catch(e){notice(e.message,true)}
  renderRight();
}

function renderRight(){
  var R=$("right");if(!R)return;
  if(!S.open){R.replaceChildren(el("p",{class:"empty",text:"Pick an email to read and answer it."}));return}
  if(!S.thread){R.replaceChildren(el("p",{class:"meta",text:"Opening…"}));return}
  var t=S.thread,last=t.messages[t.messages.length-1];
  var box=el("textarea",{id:"reply","aria-label":"Your reply"});
  var all=el("input",{type:"checkbox",id:"all",style:"width:auto"});
  var send=el("button",{class:"primary",type:"button",text:"Send as "+t.inbox.address});
  var msg=el("span",{class:"meta",role:"status"});
  send.onclick=async function(){
    if(!box.value.trim()){msg.textContent="Write your reply first.";return}
    send.disabled=true;msg.textContent="Sending…";
    try{var r=await api("/api/reply",{inbox:t.inbox.id,thread:S.open.threadId,message:last.id,text:box.value,all:all.checked});
      box.value="";msg.textContent="Sent from "+r.from+" to "+r.to.concat(r.cc).join(", ")+".";openMsg(S.open)}
    catch(e){msg.textContent=e.message;send.disabled=false}
  };
  R.replaceChildren(
    el("div",{class:"row spread"},[el("h2",{text:last.subject||"(no subject)"}),el("div",{class:"row"},[
      el("button",{type:"button",text:"Archive",onclick:async function(){try{await api("/api/modify",{inbox:t.inbox.id,thread:S.open.threadId,action:"archive"});S.messages=S.messages.filter(function(x){return x.threadId!==S.open.threadId});S.open=null;renderMid();renderRight()}catch(e){notice(e.message,true)}}}),
      el("button",{type:"button",text:"Mark unread",onclick:async function(){try{await api("/api/modify",{inbox:t.inbox.id,thread:S.open.threadId,action:"unread"});S.open.unread=true;renderMid()}catch(e){notice(e.message,true)}}})])]),
    el("p",{class:"meta",text:"In "+t.inbox.address}),
    el("div",null,t.messages.map(function(m){return el("div",{class:"mail"},[
      el("div",{class:"row spread"},[el("span",{class:"from",text:m.from}),el("span",{class:"meta",text:new Date(m.date).toLocaleString()})]),
      el("div",{class:"meta",text:"To "+m.to+(m.cc?"  Cc "+m.cc:"")}),el("div",{class:"body",text:m.text||"(no text)"})])})),
    el("div",{class:"mail"},[el("h2",{text:"Reply"}),box,el("div",{class:"row",style:"margin-top:8px"},[send,el("label",{class:"row",style:"display:flex;color:var(--ink)"},[all,el("span",{text:"Reply to everyone"})]),msg])]));
}

async function removeInbox(b){
  var i=S.inboxes.find(function(x){return x.id===S.filter});if(!i)return;
  if(b.dataset.armed!=="1"){b.dataset.armed="1";b.textContent="Click again to remove "+i.address;return}
  try{await api("/api/inbox/remove",{inbox:i.id});S.filter=null;notice("Removed "+i.address+".");load()}catch(e){notice(e.message,true)}
}

async function showTeam(){
  var R=$("right");S.open=null;
  var render=function(d){var add=el("input",{type:"email",id:"newm",placeholder:"name@domain.com","aria-label":"Add a team member"});
    R.replaceChildren(el("h2",{text:"Team"}),el("p",{class:"meta",text:"Only people listed here can sign in. Each person sees only the inboxes they connect themselves."}),
      el("ul",{class:"list"},d.members.map(function(m){return el("li",{class:"row spread mail"},[el("span",{class:"addr",text:m.email+(m.owner?" (owner)":"")}),
        m.owner?null:el("button",{type:"button",text:"Remove",onclick:async function(){render(await api("/api/team",{remove:m.email}))}})])})),
      el("div",{class:"row",style:"margin-top:10px"},[add,el("button",{class:"primary",type:"button",text:"Add person",onclick:async function(){try{render(await api("/api/team",{add:add.value}))}catch(e){notice(e.message,true)}}})]))};
  try{render(await api("/api/team"))}catch(e){notice(e.message,true)}
}

boot();
})();
`;
