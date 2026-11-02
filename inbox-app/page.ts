import { blockReport, bulkTargets, unsubReport } from "./core";

/** The Team Inbox page and its one time setup page. All text is set with textContent; an email's own HTML is shown only in a sandboxed frame where nothing runs. */

const fonts =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';

const css = `
:root{--paper:#F3F4F7;--card:#FFFFFF;--ink:#1C2230;--muted:#5D6678;--line:#DCE0E8;--accent:#2443A8;--soft:#E6EBFA;--warn:#B4322A;--warnsoft:#F8E5E3;--star:#B07800;
--display:"Bricolage Grotesque","Segoe UI",system-ui,sans-serif;--body:"IBM Plex Sans",system-ui,-apple-system,sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#12151C;--card:#1A1E28;--ink:#E7EAF2;--muted:#A0A8BA;--line:#2C3242;--accent:#8DA6FF;--soft:#232C4A;--warn:#FF8A80;--warnsoft:#3A2224;--star:#F2C14E;color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 var(--body)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px max(16px,env(safe-area-inset-left,0px)) 12px max(16px,env(safe-area-inset-right,0px));border-bottom:1px solid var(--line);background:var(--card)}
h1{font:700 22px/1 var(--display);margin:0}h2{font:700 16px/1.2 var(--display);margin:0 0 8px}
#app{height:100%;display:flex;flex-direction:column}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr) minmax(0,1.3fr);flex:1;min-height:0}
@media (max-width:980px){#app{height:auto;display:block}.wrap{grid-template-columns:minmax(0,1fr)}.col{overflow:visible}.midtop{top:0}}
.col{min-width:0;overflow:auto;padding:14px 16px;border-right:1px solid var(--line)}
.col:last-child{border-right:0;background:var(--card)}
button,.btn{font:600 13.5px var(--body);border-radius:8px;padding:7px 12px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--accent)}button:disabled{opacity:.6;cursor:default}
.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
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
select{width:100%;font:14px var(--body);color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:9px 10px}
.line{display:flex;gap:6px;align-items:stretch}.line .msg{flex:1;min-width:0}
.pick{display:flex;align-items:center;padding:0 4px;cursor:pointer}.pick input,.check{width:18px;height:18px;margin:0;accent-color:var(--accent)}
.star{padding:4px 9px;font-size:17px;line-height:1;color:var(--muted)}.star[aria-pressed=true]{color:var(--star)}
.midtop{position:sticky;top:-14px;z-index:3;background:var(--paper);margin:-14px -16px 0;padding:14px 16px 8px;border-bottom:1px solid var(--line)}
.bulk{margin-top:10px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.danger{color:var(--warn)}.danger:hover{border-color:var(--warn)}
.search{margin-top:10px;flex-wrap:nowrap}.search input{flex:1;min-width:0}
.atts{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}.atts li{gap:8px}
.form{display:grid;gap:8px}
.senders{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.sender{border:1px solid var(--line);border-radius:10px;padding:9px 11px;display:grid;gap:6px}
.count{font:700 15px var(--display);min-width:2.5em;text-align:right}
.rules{margin-top:18px}.rules select,.rules input{width:auto;flex:1 1 160px}
@media (max-width:980px){.folders{display:flex;flex-wrap:wrap}.folders li{flex:1 1 40%}}
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
var store={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
var S={busy:false,headNote:null,primary:store.get("ti_primary")!=="0",clean:{inbox:"",data:null,loading:false,error:null,rules:null,seq:0},me:null,inboxes:[],messages:[],filter:null,folder:"inbox",search:"",unread:false,open:null,thread:null,threadError:null,loading:false,next:null,seq:0,openSeq:0,sel:{},view:null,draft:null,fwd:null};
var FOLDERS=[["inbox","Inbox"],["starred","Starred"],["sent","Sent"],["trash","Trash"]];
var keyOf=function(m){return m.inboxId+":"+m.threadId};
// Shared with the server code and tested there; each one stands alone.
var bulkTargets=${bulkTargets.toString()};
var unsubReport=${unsubReport.toString()};
var blockReport=${blockReport.toString()};
async function api(p,b){var r=await fetch(p,b?{method:"POST",headers:{"Content-Type":"application/json","X-Team-Inbox":"1"},body:JSON.stringify(b)}:{});var d=await r.json().catch(function(){return{}});if(!r.ok)throw Object.assign(new Error(d.error||"Something went wrong."),{status:r.status});return d}
var when=function(ms){var d=new Date(ms),n=new Date();return d.toDateString()===n.toDateString()?d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}):d.toLocaleDateString([], d.getFullYear()===n.getFullYear()?{month:"short",day:"numeric"}:{month:"short",day:"numeric",year:"numeric"})};
var nameOf=function(h){var m=String(h||"").match(/^\\s*"?([^"<]+?)"?\\s*</);return m?m[1]:String(h||"")};
var sizeOf=function(n){n=Number(n)||0;return n<1024?n+" B":n<1048576?Math.round(n/1024)+" KB":(n/1048576).toFixed(1)+" MB"};
function put(n){n.replaceChildren.apply(n,Array.prototype.slice.call(arguments,1).filter(Boolean))}
function notice(text,bad){var n=$("notice");if(!n)return;n.textContent=text||"";n.hidden=!text;n.className="notice"+(bad?" bad":"")}
function toRight(){if(window.matchMedia("(max-width: 980px)").matches){var R=$("right");if(R&&R.scrollIntoView)R.scrollIntoView({behavior:"smooth",block:"start"})}}

async function boot(){
  // Messages come only from this app's own short lived cookie, never from the address bar.
  var note=null;document.cookie.split(";").forEach(function(c){var p=c.trim().split("=");if(p[0]==="__Host-ti_notice"){try{note=decodeURIComponent(p.slice(1).join("="))}catch(e){}}});
  if(note)document.cookie="__Host-ti_notice=; Path=/; Max-Age=0; Secure; SameSite=Lax";
  if(location.search)history.replaceState(null,"","/");
  var d=await api("/api/me").catch(function(){return null});
  if(!d){put($("app"),el("div",{class:"center"},[el("p",{class:"err",text:"Team Inbox couldn't be reached. Reload to try again."})]));return}
  if(!d.setUp){put($("app"),el("div",{class:"center"},[el("div",{class:"card"},[el("h1",{text:"Team Inbox"}),el("p",{text:"Not set up yet. Open the setup link you were given."})])]));return}
  if(!d.me){put($("app"),el("div",{class:"center"},[el("div",{class:"card"},[el("h1",{text:"Team Inbox"}),el("p",{class:"meta",text:"All your team's inboxes in one place. Sign in with your Google account."}),note?el("p",{class:"notice",text:note}):null,el("a",{class:"btn primary",href:"/api/auth/login",text:"Sign in with Google"})])]));return}
  S.me=d.me;layout();if(note)notice(note,/isn't|cancel|expired|didn't|Please|first/i.test(note));load();
}

function layout(){
  put($("app"),
    el("div",{class:"top"},[el("h1",{text:"Team Inbox"}),el("div",{class:"row"},[el("span",{class:"meta",text:S.me.email}),
      S.me.owner?el("button",{type:"button",text:"Team",onclick:showTeam}):null,
      el("button",{type:"button",text:"Sign out",onclick:async function(){try{await api("/api/auth/logout",{});location.href="/"}catch(e){notice(e.message,true)}}})])]),
    el("p",{id:"notice",class:"notice",hidden:""}),
    el("div",{class:"wrap"},[el("section",{class:"col",id:"left","aria-label":"Inboxes"}),el("section",{class:"col",id:"mid","aria-label":"Messages"}),el("section",{class:"col",id:"right","aria-label":"Open email"})]));
  renderLeft();renderMid();renderRight();
}

// Each load carries a number; an older answer that arrives late is dropped, so the list always matches the buttons.
async function load(more){
  var mine=++S.seq;if(!more){S.loading=true;S.next=null;S.sel={};renderLeft();renderMid()}
  try{var p={folder:S.folder};if(S.unread)p.unread="1";if(S.filter)p.inbox=S.filter;if(S.search)p.q=S.search;if(S.primary&&S.folder==="inbox")p.primary="1";if(more&&S.next)p.pages=JSON.stringify(S.next);
    var d=await api("/api/mail?"+new URLSearchParams(p));
    if(mine!==S.seq)return;
    if(more)S.messages=S.messages.concat(d.messages).sort(function(a,b){return b.date-a.date});else{S.inboxes=d.inboxes;S.messages=d.messages}
    var nx={},any=false;d.inboxes.forEach(function(i){if(i.next){nx[i.id]=i.next;any=true}});S.next=any?nx:null;
    if(d.swept)notice("Your rules removed "+d.swept+(d.swept===1?" email.":" emails."))}
  catch(e){if(mine!==S.seq)return;if(e.status===401){location.href="/";return}notice(e.message,true)}
  S.loading=false;renderLeft();renderMid();
}

function renderLeft(){
  var L=$("left");if(!L)return;
  var folders=FOLDERS.map(function(f){return el("li",null,[el("button",{type:"button","aria-pressed":String(S.folder===f[0]),onclick:function(){S.folder=f[0];load()}},[el("span",{class:"addr",text:f[1]})])])});
  var items=[el("li",null,[el("button",{type:"button","aria-pressed":String(!S.filter),onclick:function(){S.filter=null;load()}},[el("span",{class:"addr",text:"All inboxes"})])])];
  S.inboxes.forEach(function(i){items.push(el("li",null,[el("button",{type:"button","aria-pressed":String(S.filter===i.id),onclick:function(){S.filter=i.id;load()}},[
    el("span",{class:"addr",text:i.address}),i.error?el("span",{class:"err",text:i.error}):null]),
    i.reconnect?el("a",{class:"btn",href:"/api/auth/connect?hint="+encodeURIComponent(i.address),text:"Connect "+i.address+" again",style:"margin:4px 0 0"}):null]))});
  var hint=el("input",{id:"hint",type:"email",placeholder:"info@yourdomain.com","aria-label":"Address to connect"});
  put(L,
    el("button",{class:"primary",type:"button",id:"compose",text:"Write an email",style:"width:100%",onclick:function(){compose()}}),
    el("ul",{class:"inboxes folders","aria-label":"Folders"},folders),
    el("button",{type:"button",id:"cleanup",text:"Clean up",style:"width:100%","aria-pressed":String(S.view==="clean"),onclick:function(){showClean()}}),
    el("h2",{text:"Inboxes",style:"margin-top:14px"}),
    S.inboxes.length?null:el("p",{class:"empty",text:"No inbox connected yet. Add one below; you'll sign in to it with Google."}),
    el("ul",{class:"inboxes"},items),
    el("label",{class:"meta",style:"margin-top:8px"},[el("span",{text:"Add an inbox"}),hint]),
    el("div",{class:"row",style:"margin-top:6px"},[el("button",{type:"button",text:"Connect with Google",onclick:function(){location.href="/api/auth/connect"+(hint.value?"?hint="+encodeURIComponent(hint.value.trim()):"")}})]),
    S.filter?el("p",{style:"margin-top:14px"},[el("button",{type:"button",text:"Remove this inbox",onclick:function(e){removeInbox(e.currentTarget)}})]):null);
}

// What an action does to the rows already shown, so the list changes at once.
function applyLocal(action,keys){
  var gone=function(m){var k=keys[keyOf(m)];if(!k)return false;
    return action==="trash"?S.folder!=="trash":action==="archive"?S.folder==="inbox":action==="untrash"?S.folder==="trash":action==="unstar"?S.folder==="starred":false};
  S.messages.forEach(function(m){if(!keys[keyOf(m)])return;if(action==="read")m.unread=false;if(action==="unread")m.unread=true;if(action==="star")m.starred=true;if(action==="unstar")m.starred=false});
  var closed=S.open&&gone(S.open);
  S.messages=S.messages.filter(function(m){return !gone(m)});
  Object.keys(keys).forEach(function(k){if(!S.messages.some(function(m){return keyOf(m)===k}))delete S.sel[k]});
  if(closed){S.open=null;S.thread=null;renderRight()}
  renderMid();
}
var DONE={trash:"Moved to Trash",archive:"Archived",read:"Marked read",unread:"Marked unread",untrash:"Restored",star:"Starred",unstar:"Unstarred"};
async function bulk(action,btn){
  var items=S.messages.filter(function(m){return S.sel[keyOf(m)]}).map(function(m){return{inbox:m.inboxId,thread:m.threadId}});
  if(!items.length)return;if(btn)btn.disabled=true;
  var keys={},failed=0,err=null;
  for(var i=0;i<items.length;i+=100){
    try{var r=await api("/api/bulk",{action:action,items:items.slice(i,i+100)});r.done.forEach(function(x){keys[x.inbox+":"+x.thread]=true});failed+=r.failed;err=err||r.error}
    catch(e){failed+=Math.min(100,items.length-i);err=e.message}}
  var n=Object.keys(keys).length;
  applyLocal(action,keys);
  notice((n?DONE[action]+": "+n+(n===1?" email.":" emails."):"")+(failed?" "+failed+" couldn't be changed: "+err:""),failed>0);
}
async function threadAct(t,action){
  try{await api("/api/modify",{inbox:t.inbox.id,thread:t.threadId,action:action});var k={};k[t.inbox.id+":"+t.threadId]=true;
    if(action==="star"||action==="unstar")S.thread.starred=action==="star";applyLocal(action,k);if(S.thread&&S.open)renderRight();notice(DONE[action]+".")}
  catch(e){notice(e.message,true)}
}

// ---------- Unsubscribe and Block for chosen mail or the open email ----------
var SENDER_CAP=50;
async function each(list,limit,fn){var out=new Array(list.length),i=0;
  async function work(){while(i<list.length){var j=i++;out[j]=await fn(list[j])}}
  var ws=[];for(var k=0;k<Math.min(limit,list.length);k++)ws.push(work());await Promise.all(ws);return out}
// A result line, with the unsubscribe pages to open as buttons (new tab, nothing about this page passed on).
function report(n,text,links,bad){if(!n)return;n.textContent=text||"";
  (links||[]).forEach(function(l){n.append(" ",el("a",{class:"btn",href:l.url,target:"_blank",rel:"noopener noreferrer",text:"Open page for "+l.sender}))})}
function senderNote(text,links,bad,head){
  if(head&&S.open&&keyOf(S.open)===head){S.headNote={key:head,text:text,links:links||[],bad:bad};renderRight();return}
  var n=$("notice");if(!n)return;n.hidden=!text;n.className="notice"+(bad?" bad":"");report(n,text,links,bad)}
function senderButton(kind,targets){
  var b=el("button",{type:"button",class:kind==="block"?"danger":"",text:kind==="block"?"Block":"Unsubscribe"});b.disabled=S.busy;
  b.onclick=function(){
    if(!targets.length){notice(kind==="block"?"None of these have a sender to block.":"None of these have a sender to unsubscribe from.",true);return}
    if(targets.length>SENDER_CAP){notice("Pick "+SENDER_CAP+" senders or fewer at a time. These have "+targets.length+".",true);return}
    if(targets.length>1&&b.dataset.armed!=="1"){b.dataset.armed="1";b.textContent=kind==="block"?"Click again to block "+targets.length+" senders":"Click again to unsubscribe from "+targets.length+" senders";return}
    (kind==="block"?blockSenders:unsubSenders)(targets,b,null)};
  return b;
}
async function unsubSenders(targets,btn,head){
  if(S.busy)return;S.busy=true;if(btn)btn.disabled=true;
  senderNote("Unsubscribing from "+targets.length+(targets.length===1?" sender…":" senders…"),[],false,head);
  var res=await each(targets,3,async function(t){
    try{var r=await api("/api/unsubscribe",{inbox:t.inbox,sender:t.sender});return{sender:t.sender,done:r.done,url:r.url,message:r.message}}
    catch(e){return{sender:t.sender,error:e.message}}});
  S.busy=false;var out=unsubReport(res);
  if(!head)renderMid();senderNote(out.text,out.links,out.bad,head);
  // Senders that give no way to unsubscribe: one click blocks them, but only when the owner chooses (receipts and bank alerts often have no link either).
  var noWay=targets.filter(function(t,i){var r=res[i];return r&&!r.error&&!r.done});
  var n=$("notice");if(noWay.length&&!head&&n)n.append(" ",el("button",{type:"button",class:"danger",text:noWay.length===1?"Block it":"Block them",onclick:function(e){blockSenders(noWay,e.currentTarget,null)}}));
}
async function blockSenders(targets,btn,head){
  if(S.busy)return;S.busy=true;if(btn)btn.disabled=true;
  senderNote("Blocking "+targets.length+(targets.length===1?" sender…":" senders…"),[],false,head);
  var res=await each(targets,2,async function(t){
    try{var r=await api("/api/rules/add",{inbox:t.inbox,sender:t.sender,action:"trash"});return{sender:t.sender,swept:r.swept,sweepError:r.error}}
    catch(e){return{sender:t.sender,error:e.message}}});
  S.busy=false;var out=blockReport(res);
  // The rules and the Clean up counts changed: read them again when shown.
  S.clean.rules=null;S.clean.data=null;if(S.view==="clean"){loadSenders(false);loadRules()}
  await load();senderNote(out.text,[],out.bad,head);
}

function renderMid(){
  var M=$("mid");if(!M)return;
  var fname=(FOLDERS.find(function(f){return f[0]===S.folder})||FOLDERS[0])[1];
  var iname=S.filter?(S.inboxes.find(function(i){return i.id===S.filter})||{}).address||"":"All inboxes";
  var head=el("div",{class:"row spread"},[el("h2",{text:fname+" · "+iname}),
    el("div",{class:"row"},[S.folder==="inbox"?el("button",{type:"button",id:"primary","aria-pressed":String(S.primary),text:S.primary?"Important only":"Showing all",title:"Important only shows the Primary tab",onclick:function(){S.primary=!S.primary;store.set("ti_primary",S.primary?"1":"0");load()}}):null,
      el("button",{type:"button","aria-pressed":String(S.unread),text:S.unread?"Showing unread":"Unread only",onclick:function(){S.unread=!S.unread;load()}}),el("button",{type:"button",text:"Refresh",onclick:function(){load()}})])]);
  var q=el("input",{type:"search",id:"q",placeholder:"Search mail","aria-label":"Search mail"});q.value=S.search;
  var search=el("form",{class:"row search",role:"search",onsubmit:function(e){e.preventDefault();S.search=q.value.trim();load()}},[q,el("button",{type:"submit",text:"Search"}),
    S.search?el("button",{type:"button",text:"Clear",onclick:function(){S.search="";load()}}):null]);
  if(S.loading){put(M,head,search,el("p",{class:"meta",text:"Loading mail…"}));return}
  if(!S.messages.length){put(M,head,search,el("p",{class:"empty",text:S.search?"No email matches that search.":!S.inboxes.length?"Connect an inbox to see its mail here.":S.folder==="inbox"?"Nothing here. Your inbox is clear.":"Nothing here."}));return}
  var addr={};S.inboxes.forEach(function(i){addr[i.id]=i.address});
  var keys=S.messages.map(keyOf),n=keys.filter(function(k){return S.sel[k]}).length;
  var all=el("input",{type:"checkbox",class:"check",id:"selall","aria-label":"Select all"});all.checked=n>0&&n===keys.length;all.indeterminate=n>0&&n<keys.length;
  all.onchange=function(){var on=all.checked;S.sel={};if(on)keys.forEach(function(k){S.sel[k]=true});renderMid()};
  var acts=[];
  if(n){
    if(S.folder==="trash")acts.push(el("button",{type:"button",text:"Restore",onclick:function(e){bulk("untrash",e.currentTarget)}}));
    else{
      var del=el("button",{type:"button",class:"danger",id:"bulkdel",text:"Delete"});
      del.onclick=function(){if(n>1&&del.dataset.armed!=="1"){del.dataset.armed="1";del.textContent="Click again to delete "+n;return}bulk("trash",del)};
      acts.push(del);
      if(S.folder!=="sent")acts.push(el("button",{type:"button",text:"Archive",onclick:function(e){bulk("archive",e.currentTarget)}}));
    }
    acts.push(el("button",{type:"button",text:"Mark read",onclick:function(e){bulk("read",e.currentTarget)}}),el("button",{type:"button",text:"Mark unread",onclick:function(e){bulk("unread",e.currentTarget)}}));
    if(S.folder!=="sent"&&S.folder!=="trash"){var targets=bulkTargets(S.messages.filter(function(m){return S.sel[keyOf(m)]}));
      acts.push(senderButton("unsub",targets),senderButton("block",targets))}
  }
  var bar=el("div",{class:"row bulk"},[el("label",{class:"row",style:"display:flex;color:var(--ink);gap:6px"},[all,el("span",{text:n?n+" selected":"Select all"})])].concat(acts));
  // The heading, search and action bar stay pinned while the list scrolls, so Delete, Unsubscribe and Block are always in reach.
  put(M,el("div",{class:"midtop"},[head,search,bar]),el("ul",{class:"list"},S.messages.map(function(m){
    var k=keyOf(m);
    var cb=el("input",{type:"checkbox","aria-label":"Select "+m.subject});cb.checked=Boolean(S.sel[k]);
    cb.onchange=function(){if(cb.checked)S.sel[k]=true;else delete S.sel[k];renderMid()};
    var who=S.folder==="sent"?"To "+nameOf(m.to):nameOf(m.from);
    return el("li",{class:"line"},[el("label",{class:"pick"},[cb]),
      el("button",{type:"button",class:"msg"+(m.unread?" unread":""),"aria-current":String(Boolean(S.open&&keyOf(S.open)===k)),onclick:function(){openMsg(m)}},[
      el("span",{class:"row spread"},[el("span",{class:"from",text:who}),el("span",{class:"meta",text:when(m.date)})]),
      el("span",{class:"subj",text:m.subject+(m.count>1?"  ("+m.count+")":"")}),el("span",{class:"snip",text:m.snippet}),
      S.filter?null:el("span",null,[el("span",{class:"tag",text:addr[m.inboxId]||""})])]),
      S.folder==="trash"?null:el("button",{type:"button",class:"star","aria-pressed":String(Boolean(m.starred)),"aria-label":m.starred?"Unstar":"Star",title:m.starred?"Unstar":"Star",text:m.starred?"★":"☆",onclick:async function(){
        var act=m.starred?"unstar":"star";try{await api("/api/modify",{inbox:m.inboxId,thread:m.threadId,action:act});var o={};o[k]=true;applyLocal(act,o)}catch(e){notice(e.message,true)}}})])})),
    S.next?el("p",{style:"margin-top:10px"},[el("button",{type:"button",text:"Load more",onclick:function(e){e.currentTarget.disabled=true;load(true)}})]):null);
}

async function openMsg(m){
  var mine=++S.openSeq;S.headNote=null;if(S.view==="clean"){S.view=null;renderLeft()}S.view=null;S.fwd=null;S.open=m;S.thread=null;S.threadError=null;renderMid();renderRight();
  // On a phone the email opens below the list: bring it into view.
  toRight();
  try{var t=await api("/api/thread?"+new URLSearchParams({inbox:m.inboxId,thread:m.threadId,folder:S.folder}));
    if(mine!==S.openSeq)return;t.starred=Boolean(m.starred);S.thread=t;
    if(m.unread){api("/api/modify",{inbox:m.inboxId,thread:m.threadId,action:"read"}).then(function(){m.unread=false;renderMid()}).catch(function(e){notice("Couldn't mark it read in Gmail: "+e.message,true)})}}
  catch(e){if(mine!==S.openSeq)return;S.threadError=e.message}
  renderRight();
}

// To and Cc fields shared by writing and forwarding.
function field(label,input){return el("label",null,[el("span",{text:label}),input])}

function compose(){
  S.openSeq++;S.open=null;S.thread=null;S.fwd=null;S.view="compose";renderLeft();
  if(!S.draft)S.draft={inbox:S.filter||(S.inboxes[0]||{}).id||"",to:"",cc:"",subject:"",text:""};
  renderMid();renderRight();toRight();var to=$("cto");if(to)to.focus();
}
function renderCompose(R){
  var D=S.draft;
  if(!S.inboxes.length){put(R,el("h2",{text:"Write an email"}),el("p",{class:"empty",text:"Connect an inbox first, then you can send from it here."}));return}
  var from=el("select",{id:"cfrom","aria-label":"From"},S.inboxes.map(function(i){return el("option",{value:i.id,text:i.address})}));from.value=D.inbox||S.inboxes[0].id;D.inbox=from.value;
  var to=el("input",{id:"cto",type:"text",autocomplete:"off",placeholder:"name@domain.com"}),cc=el("input",{id:"ccc",type:"text",autocomplete:"off"}),sub=el("input",{id:"csub",type:"text"}),box=el("textarea",{id:"cbody","aria-label":"Message"});
  to.value=D.to;cc.value=D.cc;sub.value=D.subject;box.value=D.text;
  var keep=function(){D.inbox=from.value;D.to=to.value;D.cc=cc.value;D.subject=sub.value;D.text=box.value};
  [from,to,cc,sub,box].forEach(function(n){n.addEventListener("input",keep);n.addEventListener("change",keep)});
  var msg=el("span",{class:"meta",role:"status"});
  var go=el("button",{class:"primary",type:"button",text:"Send"});
  go.onclick=async function(){keep();if(!D.to.trim()){msg.textContent="Add who it goes to.";return}
    go.disabled=true;msg.textContent="Sending…";
    try{var r=await api("/api/send",{inbox:D.inbox,to:D.to,cc:D.cc,subject:D.subject,text:D.text});S.draft=null;S.view=null;renderRight();
      notice("Sent from "+r.from+" to "+r.to.concat(r.cc).join(", ")+".");if(S.folder==="sent")load()}
    catch(e){msg.textContent=e.message;go.disabled=false}};
  put(R,el("div",{class:"form"},[el("h2",{text:"Write an email"}),field("From",from),field("To",to),field("Cc",cc),field("Subject",sub),box,
    el("div",{class:"row"},[go,el("button",{type:"button",text:"Discard",onclick:function(){S.draft=null;S.view=null;renderRight()}}),msg])]));
}

function forwardBox(t,m){
  var to=el("input",{id:"fto",type:"text",autocomplete:"off",placeholder:"name@domain.com"}),cc=el("input",{id:"fcc",type:"text",autocomplete:"off"});
  var box=el("textarea",{id:"fnote","aria-label":"Your note",placeholder:"Add a note (optional)"});
  var msg=el("span",{class:"meta",role:"status"});
  var go=el("button",{class:"primary",type:"button",text:"Forward from "+t.inbox.address});
  go.onclick=async function(){if(!to.value.trim()){msg.textContent="Add who it goes to.";return}
    go.disabled=true;msg.textContent="Sending…";
    try{var r=await api("/api/forward",{inbox:t.inbox.id,thread:t.threadId,message:m.id,to:to.value,cc:cc.value,text:box.value});S.fwd=null;renderRight();notice("Forwarded from "+r.from+" to "+r.to.concat(r.cc).join(", ")+".")}
    catch(e){msg.textContent=e.message;go.disabled=false}};
  return el("div",{class:"mail form",id:"forward"},[el("h2",{text:"Forward"}),el("p",{class:"meta",text:"Sends the text of the email from "+nameOf(m.from)+". Attachments are not included."}),
    field("To",to),field("Cc",cc),box,el("div",{class:"row"},[go,el("button",{type:"button",text:"Cancel",onclick:function(){S.fwd=null;renderRight()}}),msg])]);
}

function renderRight(){
  var R=$("right");if(!R)return;
  if(S.view==="compose")return renderCompose(R);
  if(S.view==="clean")return renderClean(R);
  if(!S.open){put(R,el("p",{class:"empty",text:"Pick an email to read and answer it."}));return}
  if(S.threadError){put(R,el("p",{class:"err",text:S.threadError}),el("button",{type:"button",text:"Try again",onclick:function(){openMsg(S.open)}}));return}
  if(!S.thread){put(R,el("p",{class:"meta",text:"Opening…"}));return}
  var t=S.thread,last=t.messages[t.messages.length-1];
  if(!last){put(R,el("p",{class:"empty",text:"This conversation has nothing left to show."}));return}
  var trashed=S.folder==="trash";
  // Answer the other person: the latest message not sent by this inbox (a thread can end with your own forward).
  var answer=t.answer||{id:last.id,to:[]};
  var box=el("textarea",{id:"reply","aria-label":"Your reply"});
  var all=el("input",{type:"checkbox",id:"all",class:"check"});
  var quote=el("input",{type:"checkbox",id:"quote",class:"check"});quote.checked=true;
  var send=el("button",{class:"primary",type:"button",text:"Send as "+t.inbox.address});
  var msg=el("span",{class:"meta",role:"status"});
  send.onclick=async function(){
    if(!box.value.trim()){msg.textContent="Write your reply first.";return}
    send.disabled=true;msg.textContent="Sending…";
    try{var r=await api("/api/reply",{inbox:t.inbox.id,thread:t.threadId,message:answer.id,text:box.value,all:all.checked,quote:quote.checked});
      box.value="";msg.textContent="Sent from "+r.from+" to "+r.to.concat(r.cc).join(", ")+".";openMsg(S.open)}
    catch(e){msg.textContent=e.message;send.disabled=false}
  };
  var acts=trashed?[el("button",{type:"button",text:"Restore",onclick:function(){threadAct(t,"untrash")}})]:[
    el("button",{type:"button",class:"star","aria-pressed":String(Boolean(t.starred)),"aria-label":t.starred?"Unstar":"Star",title:t.starred?"Unstar":"Star",text:t.starred?"★":"☆",onclick:function(){threadAct(t,t.starred?"unstar":"star")}}),
    S.folder==="sent"?null:el("button",{type:"button",text:"Archive",onclick:function(){threadAct(t,"archive")}}),
    el("button",{type:"button",class:"danger",text:"Delete",onclick:function(){threadAct(t,"trash")}}),
    el("button",{type:"button",text:"Mark unread",onclick:async function(){try{await api("/api/modify",{inbox:t.inbox.id,thread:t.threadId,action:"unread"});S.open.unread=true;renderMid()}catch(e){notice(e.message,true)}}})];
  var who=!trashed&&t.sender&&t.sender.address?t.sender.address:null,here=keyOf(S.open),tg=who?[{inbox:t.inbox.id,sender:who}]:[];
  if(who){
    if(t.sender.canUnsubscribe){var ub=el("button",{type:"button",text:"Unsubscribe",title:"Unsubscribe from "+who});ub.disabled=S.busy;ub.onclick=function(){unsubSenders(tg,ub,here)};acts.push(ub)}
    var bb=el("button",{type:"button",class:"danger",text:"Block sender",title:"Always delete mail from "+who});bb.disabled=S.busy;bb.onclick=function(){blockSenders(tg,bb,here)};acts.push(bb);
  }
  var hn=S.headNote&&S.headNote.key===here?S.headNote:null,hline=null;
  if(hn){hline=el("p",{class:hn.bad?"err":"meta",role:"status",id:"headnote"});report(hline,hn.text,hn.links,hn.bad)}
  put(R,
    el("div",{class:"row spread"},[el("h2",{text:last.subject||"(no subject)"}),el("div",{class:"row"},acts)]),
    el("p",{class:"meta",text:"In "+t.inbox.address+(trashed?" (in Trash)":"")}),hline,
    el("div",null,t.messages.map(function(m){return el("div",{class:"mail"},[
      el("div",{class:"row spread"},[el("span",{class:"from",text:m.from}),el("span",{class:"meta",text:new Date(m.date).toLocaleString()})]),
      el("div",{class:"row spread"},[el("div",{class:"meta",text:"To "+m.to+(m.cc?"  Cc "+m.cc:"")}),el("button",{type:"button",text:"Forward",onclick:function(){S.fwd=m.id;renderRight();var f=$("fto");if(f){f.focus();if(f.scrollIntoView)f.scrollIntoView({block:"center"})}}})]),
      showBody(m),attachmentList(t,m)])})),
    S.fwd?forwardBox(t,t.messages.find(function(m){return m.id===S.fwd})||last):null,
    trashed?null:el("div",{class:"mail"},[el("h2",{text:"Reply"}),el("p",{class:"meta",text:answer.to.length?"To "+answer.to.join(", ")+" (reply all adds the others on that message)":"There's no one to reply to on this conversation."}),box,
      el("div",{class:"row",style:"margin-top:8px"},[send,el("label",{class:"row",style:"display:flex;color:var(--ink)"},[all,el("span",{text:"Reply to everyone"})]),
        el("label",{class:"row",style:"display:flex;color:var(--ink)"},[quote,el("span",{text:"Include the original"})]),msg])]));
}

function attachmentList(t,m){
  if(!m.attachments||!m.attachments.length)return null;
  return el("ul",{class:"atts","aria-label":"Attachments"},m.attachments.map(function(x){
    return el("li",{class:"row"},[el("span",{class:"addr",text:x.name}),el("span",{class:"meta",text:sizeOf(x.size)}),
      el("a",{class:"btn",href:"/api/attachment?"+new URLSearchParams({inbox:t.inbox.id,message:m.id,part:x.part}),download:x.name,text:"Download"})])}));
}

// An email's own design is shown in a sandboxed frame: nothing in it can run, submit forms or reach this page.
// Images load by default (the owner's choice); inline images arrive from the server as data: addresses. Hide images turns outside ones off.
function emailDoc(html,images){
  if(images===undefined)images=true;
  // Parsed into an inert document first (nothing loads while parsing), so outside images, styles and frames can be removed for real.
  var d=new DOMParser().parseFromString(html,"text/html");
  d.querySelectorAll("script,iframe,frame,object,embed,form,link,meta,base").forEach(function(n){n.remove()});
  d.querySelectorAll("*").forEach(function(n){
    for(var i=n.attributes.length-1;i>=0;i--){var a=n.attributes[i].name,v=n.attributes[i].value.replace(/\\s+/g,"").toLowerCase();if(a.slice(0,2)==="on"||((a==="href"||a==="xlink:href")&&/^(javascript|data|vbscript):/.test(v)))n.removeAttribute(a)}
    if(!images){
      ["src","srcset","background","poster"].forEach(function(a){var v=n.getAttribute(a);if(v&&!/^(data|cid):/i.test(v.trim()))n.removeAttribute(a)});
      var st=n.getAttribute("style");if(st&&/url\\(/i.test(st))n.setAttribute("style",st.replace(/url\\([^)]*\\)/gi,"none"));
    }
  });
  if(!images)d.querySelectorAll("style").forEach(function(n){n.textContent=n.textContent.replace(/url\\([^)]*\\)/gi,"none").replace(/@import[^;]*;/gi,"")});
  var policy="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"+(images?" https:":"");
  var head='<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><base target="_blank"><style>body{margin:12px;font:14px/1.5 system-ui,sans-serif;color:#1d1d1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>';
  var styles=Array.prototype.map.call(d.querySelectorAll("style"),function(n){return n.outerHTML}).join("");
  return "<!doctype html><html><head>"+head+styles+"</head><body>"+d.body.innerHTML+"</body></html>";
}
function showBody(m){
  if(!m.html)return el("div",{class:"body",text:m.text||"(no text)"});
  var frame=el("iframe",{sandbox:"allow-popups allow-popups-to-escape-sandbox",title:"Email from "+m.from,referrerpolicy:"no-referrer",style:"width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff;margin-top:8px"});
  var shown=true;frame.srcdoc=emailDoc(m.html,true);
  var imgs=el("button",{type:"button",text:"Hide images",onclick:function(){shown=!shown;frame.srcdoc=emailDoc(m.html,shown);imgs.textContent=shown?"Hide images":"Show images"}});
  var plain=el("div",{class:"body",text:m.text||"(no text version)",hidden:""});
  var toggle=el("button",{type:"button",text:"Text version",onclick:function(){var t=plain.hidden;plain.hidden=!t;frame.hidden=t;toggle.textContent=t?"Designed version":"Text version"}});
  return el("div",null,[el("div",{class:"row",style:"margin-top:8px"},[imgs,toggle]),frame,plain]);
}

// ---------- Clean up: senders, unsubscribe, delete all, rules ----------
function showClean(){
  S.openSeq++;S.open=null;S.thread=null;S.fwd=null;S.view="clean";
  if(S.clean.inbox&&!S.inboxes.some(function(i){return i.id===S.clean.inbox}))S.clean.inbox="";
  renderLeft();renderMid();renderRight();toRight();
  if(!S.clean.data&&!S.clean.loading)loadSenders(false);
  if(!S.clean.rules)loadRules();
}
async function loadSenders(fresh){
  var C=S.clean,mine=++C.seq;C.loading=true;C.error=null;renderRight();
  try{var p={};if(C.inbox)p.inbox=C.inbox;if(fresh)p.fresh="1";var d=await api("/api/senders?"+new URLSearchParams(p));if(mine!==C.seq)return;C.data=d}
  catch(e){if(mine!==C.seq)return;if(e.status===401){location.href="/";return}C.error=e.message}
  C.loading=false;renderRight();
}
async function loadRules(){
  try{S.clean.rules=(await api("/api/rules")).rules}catch(e){S.clean.rules=[];notice(e.message,true)}
  renderRight();
}
// After a sender's mail is deleted, the row and the count change at once.
function dropSender(g){
  var d=S.clean.data;if(!d)return;
  d.senders=d.senders.filter(function(x){return x!==g});d.total-=g.count;if(g.unsub)d.unsubscribable-=g.count;
}
function senderRow(g,addr){
  var who=g.name?g.name+" <"+g.address+">":g.address;
  var msg=el("span",{class:"meta",role:"status"});
  var acts=[];
  if(g.unsub){var u=el("button",{type:"button",text:"Unsubscribe"});
    u.onclick=async function(){u.disabled=true;msg.textContent="Unsubscribing…";
      try{var r=await api("/api/unsubscribe",{inbox:g.inboxId,sender:g.address});msg.textContent=r.message||"";
        if(r.done==="link"&&/^https:\\/\\//i.test(String(r.url||""))){msg.append(" ",el("a",{href:r.url,target:"_blank",rel:"noopener noreferrer",text:"Open their unsubscribe page"}))}
        if(r.done==="posted"||r.done==="emailed"){g.unsub=null;u.textContent="Unsubscribed"}else u.disabled=false}
      catch(e){msg.textContent=e.message;u.disabled=false}};
    acts.push(u)}
  var del=el("button",{type:"button",class:"danger",text:"Delete all "+g.count});
  del.onclick=async function(){if(del.dataset.armed!=="1"){del.dataset.armed="1";del.textContent="Click again to delete all from "+g.address;return}
    del.disabled=true;msg.textContent="Deleting…";
    try{var r=await api("/api/sender/trash",{inbox:g.inboxId,sender:g.address});
      var t="Moved "+r.count+(r.count===1?" email":" emails")+" from "+g.address+" to Trash."+(r.failed?" "+r.failed+" couldn't be moved.":"")+(r.more?" There is more. Click again to keep going.":"");
      if(r.more){del.dataset.armed="";del.disabled=false;del.textContent="Delete more";msg.textContent=t}else{dropSender(g);renderRight();notice(t,r.failed>0)}}
    catch(e){msg.textContent=e.message;del.disabled=false}};
  acts.push(del);
  var rule=el("button",{type:"button",text:"Always delete from now on"});
  rule.onclick=async function(){rule.disabled=true;msg.textContent="Saving rule…";
    try{var r=await api("/api/rules/add",{inbox:g.inboxId,sender:g.address,action:"trash"});
      var t="From now on mail from "+g.address+" goes to Trash."+(r.swept?" Moved "+r.swept+" now.":"")+(r.error?" Couldn't clear the old ones yet: "+r.error:"");
      dropSender(g);await loadRules();notice(t,Boolean(r.error))}
    catch(e){msg.textContent=e.message;rule.disabled=false}};
  acts.push(rule);
  return el("li",{class:"sender"},[
    el("div",{class:"row spread"},[el("span",{class:"addr",text:who}),el("span",{class:"row"},[el("span",{class:"count",text:String(g.count)}),el("span",{class:"meta",text:"last "+when(g.last)})])]),
    S.clean.inbox?null:el("span",null,[el("span",{class:"tag",text:addr[g.inboxId]||""})]),
    el("div",{class:"row"},acts.concat([msg]))]);
}
function rulesBox(){
  var rules=S.clean.rules;
  var inbox=el("select",{id:"rinbox","aria-label":"Inbox for the rule"},S.inboxes.map(function(i){return el("option",{value:i.id,text:i.address})}));
  if(S.clean.inbox)inbox.value=S.clean.inbox;
  var who=el("input",{id:"rsender",type:"text",autocomplete:"off",placeholder:"news@shop.com or @shop.com","aria-label":"Sender or domain"});
  var act=el("select",{id:"raction","aria-label":"What to do"},[el("option",{value:"trash",text:"Delete"}),el("option",{value:"archive",text:"Archive"})]);
  var msg=el("span",{class:"meta",role:"status"});
  var add=el("button",{type:"button",class:"primary",text:"Add rule"});
  add.onclick=async function(){if(!who.value.trim()){msg.textContent="Write an address or @domain.com.";return}
    add.disabled=true;msg.textContent="Saving rule…";
    try{var r=await api("/api/rules/add",{inbox:inbox.value,sender:who.value.trim(),action:act.value});
      await loadRules();notice("Rule saved for "+r.sender+"."+(r.swept?" Moved "+r.swept+" now.":"")+(r.error?" Couldn't clear the old ones yet: "+r.error:""),Boolean(r.error))}
    catch(e){msg.textContent=e.message;add.disabled=false}};
  var list=rules===null?el("p",{class:"meta",text:"Loading rules…"}):!rules.length?el("p",{class:"empty",text:"No rules yet. A rule deletes or archives mail from a sender as it arrives."}):
    el("ul",{class:"list"},rules.map(function(r){return el("li",{class:"row spread mail"},[
      el("span",{class:"addr",text:(r.action==="archive"?"Archive ":"Delete ")+r.sender+" in "+r.address}),
      el("button",{type:"button",text:"Remove",onclick:async function(e){var b=e.currentTarget;b.disabled=true;try{await api("/api/rules/remove",{id:r.id});await loadRules();notice("Rule removed.")}catch(x){notice(x.message,true);b.disabled=false}}})])}));
  return el("div",{class:"rules"},[el("h2",{text:"Rules"}),el("p",{class:"meta",text:"Rules run each time you open your mail and on a schedule."}),list,
    S.inboxes.length?el("div",{class:"row",style:"margin-top:10px"},[inbox,who,act,add,msg]):null]);
}
function renderClean(R){
  var C=S.clean;
  if(!S.inboxes.length){put(R,el("h2",{text:"Clean up"}),el("p",{class:"empty",text:"Connect an inbox first."}));return}
  var pick=el("select",{id:"cinbox","aria-label":"Inbox to clean up"},[el("option",{value:"",text:"All inboxes"})].concat(S.inboxes.map(function(i){return el("option",{value:i.id,text:i.address})})));
  pick.value=C.inbox;pick.onchange=function(){C.inbox=pick.value;C.data=null;loadSenders(false)};
  var head=el("div",{class:"row spread"},[el("h2",{text:"Clean up"}),el("div",{class:"row"},[pick,el("button",{type:"button",text:"Refresh",onclick:function(){loadSenders(true)}}),el("button",{type:"button",text:"Close",onclick:function(){S.view=null;renderLeft();renderRight()}})])]);
  var intro=el("p",{class:"meta",text:"Who sent you the most in the last 30 days. Unsubscribe, delete it all, or make a rule."});
  var body;
  if(C.loading&&!C.data)body=el("p",{class:"meta",text:"Reading the last 30 days. This can take a little while…"});
  else if(C.error)body=el("p",{class:"err",text:C.error});
  else if(!C.data)body=null;
  else{
    var d=C.data,addr={};S.inboxes.forEach(function(i){addr[i.id]=i.address});
    var notes=(d.inboxes||[]).filter(function(i){return i.error||i.partial||i.skipped}).map(function(i){
      return el("p",{class:i.error?"err":"meta",text:i.address+": "+(i.error?i.error:i.partial?"only the newest 500 emails were read.":i.skipped+" emails couldn't be read.")})});
    body=el("div",null,[el("p",{id:"cleancount",text:"Last 30 days: "+d.total+(d.total===1?" email, ":" emails, ")+d.unsubscribable+" from senders you can unsubscribe from"}),
      C.loading?el("p",{class:"meta",text:"Refreshing…"}):null].concat(notes,[
      d.senders.length?el("ul",{class:"senders"},d.senders.map(function(g){return senderRow(g,addr)})):el("p",{class:"empty",text:"No mail in the last 30 days."})]));
  }
  put(R,head,intro,body,rulesBox());
}

async function removeInbox(b){
  var i=S.inboxes.find(function(x){return x.id===S.filter});if(!i)return;
  if(b.dataset.armed!=="1"){b.dataset.armed="1";b.textContent="Click again to remove "+i.address;return}
  try{await api("/api/inbox/remove",{inbox:i.id});S.filter=null;notice("Removed "+i.address+".");load()}catch(e){notice(e.message,true)}
}

async function showTeam(){
  var R=$("right");S.open=null;S.view=null;S.openSeq++;renderLeft();
  var render=function(d){var add=el("input",{type:"email",id:"newm",placeholder:"name@domain.com","aria-label":"Add a team member"});
    put(R,el("h2",{text:"Team"}),el("p",{class:"meta",text:"Only people listed here can sign in. Each person sees only the inboxes they connect themselves."}),
      el("ul",{class:"list"},d.members.map(function(m){return el("li",{class:"row spread mail"},[el("span",{class:"addr",text:m.email+(m.owner?" (owner)":"")}),
        m.owner?null:el("button",{type:"button",text:"Remove",onclick:async function(){try{render(await api("/api/team",{remove:m.email}))}catch(e){notice(e.message,true)}}})])})),
      el("div",{class:"row",style:"margin-top:10px"},[add,el("button",{class:"primary",type:"button",text:"Add person",onclick:async function(){try{render(await api("/api/team",{add:add.value}))}catch(e){notice(e.message,true)}}})]))};
  try{render(await api("/api/team"))}catch(e){notice(e.message,true)}
}

boot();
})();
`;
