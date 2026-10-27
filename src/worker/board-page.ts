/**
 * GET /board — the Git4agents trust board, drawn as a repo shopping mall: a
 * self-contained (no CDN) illustrated SVG view of three RECORDED live runs. Every number shown comes from
 * board-data.ts, which scripts/build-board-data.py generates from the public
 * ledgers, the redacted live logs, the crew config and docs/scale-results.
 * Nothing on this page calls the authority or can change task state; the
 * "Approve & promote" button replays the recorded decision only.
 */
import { BOARD_DATA } from "./board-data.ts";

export function renderBoardPage(): string {
	const data = JSON.stringify(BOARD_DATA).replace(/</g, "\\u003c");
	return HTML.replace("__DATA__", data);
}

const HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Git4agents · trust board · the repo mall</title>
<style>
:root{--paper:#fbf4e6;--card:#fffaf0;--ink:#3b2f2a;--dim:#8a7a6d;--line:#e6d6bd;--ok:#4f9d69;--bad:#d2544c;--amb:#e0a43a;--acc:#4a7fb5;--floor:#f3e6cf}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--paper);color:var(--ink);font:14px/1.4 "Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;overflow:hidden}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#app{display:grid;grid-template-columns:1fr 380px;grid-template-rows:auto auto 1fr;height:100vh;gap:10px;padding:12px 14px}
header{grid-column:1/3;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font:700 21px/1 Georgia,"Iowan Old Style",serif;margin:0}header h1 em{color:#b5643c;font-style:italic}
.sc{display:flex;gap:6px}.sc button,.ctl button,.ctl select{background:var(--card);color:var(--ink);border:1.5px solid var(--line);border-radius:999px;padding:6px 13px;font:inherit;cursor:pointer}
.sc button[aria-pressed=true]{background:#3b2f2a;color:#fff8ec;border-color:#3b2f2a}
.ctl{margin-left:auto;display:flex;gap:6px;align-items:center;color:var(--dim)}.ctl a{color:var(--acc)}
.badge{font-weight:800;font-size:11px;padding:3px 9px;border-radius:99px;letter-spacing:.7px}.badge.real{background:#dcefdc;color:#2f6e44}.badge.viz{background:#f6e3c2;color:#8a5a12}
#stats{grid-column:1/3;display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.st{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:8px 14px}.st small{color:var(--dim);text-transform:uppercase;font-size:10.5px;letter-spacing:.9px}.st div{font:700 21px/1.2 Georgia,serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st.ok div{color:var(--ok)}.st.bad div{color:var(--bad)}.st.amb div{color:#b07a17}
#mall{position:relative;background:var(--card);border:1.5px solid var(--line);border-radius:18px;overflow:hidden;min-height:0}
#mall svg{width:100%;height:100%;display:block}
#legend{position:absolute;left:12px;bottom:8px;font-size:11.5px;color:var(--dim);background:#fffaf0e6;padding:3px 9px;border-radius:8px}
.shop{cursor:pointer}.shop:hover .front{filter:brightness(1.05) saturate(1.15)}
.who{cursor:pointer}.who .legs line{animation:walk .5s infinite alternate ease-in-out;transform-origin:0 -4px}
.who.still .legs line{animation:none}.who .legs line:nth-child(2){animation-delay:-.5s}
@keyframes walk{from{transform:rotate(-18deg)}to{transform:rotate(18deg)}}
.flag{animation:bob 1.1s infinite ease-in-out}@keyframes bob{50%{transform:translateY(-3px)}}
.pop,.flag{transform-box:fill-box;transform-origin:center}body.static *{animation:none!important}
.pop{animation:pop .45s cubic-bezier(.3,1.6,.5,1)}@keyframes pop{from{transform:scale(0)}}
#side{grid-row:3;grid-column:2;display:flex;flex-direction:column;gap:10px;min-height:0}
.receipt{flex:1;min-height:0;background:#fffdf8;border:1.5px solid var(--line);border-radius:6px 6px 0 0;display:flex;flex-direction:column;box-shadow:0 2px 0 #efe3cf;position:relative}
.receipt:after{content:"";position:absolute;left:0;right:0;bottom:-8px;height:8px;background:radial-gradient(circle at 6px 0,transparent 6px,#fffdf8 6.5px) 0 0/12px 8px repeat-x}
.receipt h2{font:700 13px/1 ui-monospace,Menlo,monospace;text-align:center;letter-spacing:2px;margin:12px 0 2px}.receipt .sub{text-align:center;color:var(--dim);font:11px ui-monospace,Menlo,monospace;border-bottom:1.5px dashed var(--line);padding-bottom:8px;margin:0 12px}
#rx{flex:1;overflow:auto;padding:6px 14px 14px;font:12px/1.45 ui-monospace,Menlo,monospace}
.ln{display:flex;gap:8px;padding:3px 0;border-bottom:1px dotted #eadcc5;animation:in .35s ease-out}.ln .s{color:var(--dim);width:34px;flex:none}.ln .k{flex:1}.ln .h{color:#b3a493}
.ln.ok .k{color:var(--ok)}.ln.bad .k{color:var(--bad);font-weight:700}.ln.amb .k{color:#b07a17}.ln.note .k{color:var(--dim);font-style:italic}
@keyframes in{from{opacity:0;transform:translateY(-4px)}}
.panel{background:var(--card);border:1.5px solid var(--line);border-radius:14px;padding:11px 13px}
.panel h3{margin:0 0 5px;font:700 15px Georgia,serif}.panel .row{font-size:12.5px;margin:2px 0}.panel .row b{color:var(--dim);font-weight:600;display:inline-block;min-width:78px}
#det{max-height:34%;overflow:auto}
.btns{display:flex;gap:8px}.btn{flex:1;padding:9px;border-radius:10px;border:0;font:inherit;font-weight:700;cursor:pointer}.btn.go{background:var(--ok);color:#fff}.btn.go:disabled{background:#e8dccb;color:#a8998a;cursor:not-allowed}.btn.no{background:#f7e1dc;color:#a1453d;border:1.5px dashed #dfa59c;cursor:not-allowed}
.refuse{color:var(--bad);font-weight:700;font-size:12.5px;margin-top:6px;min-height:17px}
.chip{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:5px;margin:1px;background:#efe5d4}.chip.p{background:#dcefdc;color:#2f6e44}.chip.f{background:#f7d9d5;color:#a1453d}

/* mall-native chrome: hanging marquee, receipt printing from the register, price-tag popovers */
html,body{background:#f6ecd9}
#app{display:block;position:relative;height:100vh;padding:0}
#mall{position:absolute;inset:0;border:0;border-radius:0;background:linear-gradient(#fde9c9,#f6f0e2)}
#mall svg{position:absolute;left:0;right:0;top:118px;bottom:0;height:calc(100% - 118px)}
#marquee{position:absolute;z-index:20;left:50%;top:0;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none}
#marquee>*{pointer-events:auto}
.chain{position:absolute;top:0;width:3px;height:16px;background:repeating-linear-gradient(#8a6a45 0 4px,transparent 4px 6px)}.chain.l{left:22%}.chain.r{right:22%}
#marquee .board{margin-top:14px;background:linear-gradient(#7a5233,#5e3d24);border:3px solid #3e2716;border-radius:14px;padding:8px 22px 9px;box-shadow:0 8px 0 #3e271633,0 14px 24px #3e271622;color:#fff3dc;text-align:center;position:relative;min-width:720px}
.bulbs{position:absolute;inset:4px;border-radius:10px;pointer-events:none;background:radial-gradient(circle,#ffe08a 0 2.2px,transparent 2.6px) 0 0/16px 16px;-webkit-mask:linear-gradient(#000 0 5px,transparent 5px calc(100% - 5px),#000 calc(100% - 5px));mask:linear-gradient(#000 0 5px,transparent 5px calc(100% - 5px),#000 calc(100% - 5px))}
#marquee h1{font:700 25px/1.1 Georgia,serif;margin:3px 0 0;letter-spacing:.5px;color:#fff3dc}#marquee h1 em{color:#ffcf7a}
.tagline{font-size:11.5px;color:#e9cfa8;letter-spacing:1px;margin:1px 0 5px}
#marquee .sc{justify-content:center;flex-wrap:wrap}#marquee .sc button{border-radius:6px;background:#fff3dc;border:2px solid #3e2716;font-weight:700;font-size:12.5px;padding:3px 10px;box-shadow:0 2px 0 #3e2716}
#marquee .sc button[aria-pressed=true]{background:#ffcf7a;color:#3e2716}
#marquee .ctl{margin:6px 0 0;justify-content:center;color:#e9cfa8;font-size:12px}#marquee .ctl button,#marquee .ctl select{padding:2px 9px;font-size:12px;background:#fff3dc}#marquee .ctl a{color:#ffd99a}
#stats{display:flex;gap:10px;margin-top:0;justify-content:center}
#stats .st{position:relative;margin-top:16px;border-radius:8px;border:2px solid #3e2716;background:#fffaf0;padding:3px 11px 4px;min-width:96px;text-align:center;box-shadow:0 3px 0 #3e271633;transform:rotate(-1deg)}
#stats .st:nth-child(even){transform:rotate(1.2deg)}
#stats .st:before,#stats .st:after{content:"";position:absolute;top:-16px;width:2px;height:16px;background:#8a6a45}#stats .st:before{left:18px}#stats .st:after{right:18px}
#stats .st small{font-size:9.5px}#stats .st div{font-size:16px}
#legend{left:50%;transform:translateX(-50%);bottom:6px;z-index:5}
#register{position:absolute;left:18px;bottom:16px;width:330px;height:min(56vh,470px);display:flex;flex-direction:column;justify-content:flex-end;z-index:10}
#register .receipt{flex:1;margin:0 26px;border-radius:0;border:0;border-left:1px solid #eadcc5;border-right:1px solid #eadcc5;box-shadow:0 0 18px #3e27161a;background:#fffdf8 repeating-linear-gradient(#fffdf8 0 23px,#fbf4e6 23px 24px)}
#register .receipt:after{top:-8px;bottom:auto;transform:rotate(180deg)}
.till{background:linear-gradient(#5e6b5a,#46523f);border:3px solid #2f382a;border-radius:12px 12px 16px 16px;padding:8px 10px 10px;box-shadow:0 8px 16px #0003}
.till-top{font:700 10px ui-monospace,Menlo,monospace;color:#d8e6c8;letter-spacing:2px;text-align:center;margin-bottom:6px;background:#1f2a1c;border-radius:5px;padding:4px}
.till .btn{border-radius:8px;box-shadow:0 3px 0 #0005}.till .refuse{color:#ffb4a8}
.tagcard{position:absolute;z-index:30;width:300px;max-height:60vh;overflow:auto;background:#fff6dc;border:2px solid #b98f4f;border-radius:6px 22px 22px 6px;padding:12px 16px 12px 30px;box-shadow:4px 6px 0 #b98f4f44,0 14px 30px #3e271626;transform:rotate(-1.5deg);font-size:12.5px}
.tagcard:before{content:"";position:absolute;left:10px;top:16px;width:10px;height:10px;border-radius:50%;background:#f6ecd9;border:2px solid #b98f4f}
.tagcard .x{position:absolute;right:10px;top:6px;border:0;background:none;font-size:16px;cursor:pointer;color:#8a6a45}
.tagcard h3{font:700 15px Georgia,serif;margin:0 0 5px}.tagcard .row{margin:2px 0}.tagcard .row b{color:#8a7a6d;font-weight:600;display:inline-block;min-width:70px}
</style></head><body><div id="app">
<header id="marquee"><i class="chain l"></i><i class="chain r"></i><div class="board"><div class="bulbs"></div><h1>Git4agents <em>repo mall</em></h1><div class="tagline">the trust board · <span id="badge" class="badge real">REAL</span></div>
<div class="sc" id="sc"></div>
<div class="ctl"><button id="play">▶ Play</button><button id="restart" title="restart">⟲</button><label>speed <select id="speed"><option>0.5</option><option selected>1</option><option>2</option><option>4</option></select>×</label><label><input type="checkbox" id="loop"> loop</label><a href="/">home</a>·<a href="/board/new">open your repo</a></div></div>
<section id="stats"></section></header>
<main id="mall"><svg id="svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mall floor plan"></svg><div id="legend"></div>
<div id="register"><div class="receipt"><h2>LEDGER RECEIPT</h2><div class="sub" id="rxsub"></div><div id="rx"></div></div>
<div class="till"><div class="till-top">REGISTER · checkout lane 1</div><div class="btns"><button class="btn go" id="approve" disabled>Approve &amp; promote</button><button class="btn no" id="override">Override gates</button></div><div class="refuse" id="refuse"></div></div></div>
<div class="tagcard" id="det" hidden></div></main>
<script>
(function(){
var D=__DATA__;
var NS="http://www.w3.org/2000/svg",svg=document.getElementById("svg");
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function S(t,a,p){var e=document.createElementNS(NS,t);for(var k in a)e.setAttribute(k,a[k]);(p||svg).appendChild(e);return e}
function T(txt,a,p){var e=S("text",a,p);e.textContent=txt;return e}
var PAL=["#e07a5f","#3d8eb9","#81b29a","#f2cc8f","#b56576","#6d597a","#e9a03b","#5fa8a0","#c97b63","#7a9e4d","#8e7dbe","#d08c60","#4f7cac"];
var AWN=["#e07a5f","#81b29a","#3d8eb9","#e9a03b","#b56576","#5fa8a0","#8e7dbe","#c97b63","#7a9e4d","#d08c60"];
var GATES={"Blind eval":["exact_baseline","scope_compliance","valid_tool_states","no_eval_tampering","static_analysis","security_policy"],"Hidden tests":["hidden_oracle","regressions"],"Provenance":["provenance_complete"]};
var sc,people={},shops={},tweens=[],steps=[],si=0,timer=null,playing=false,instant=false,promoted=false,verdict=false;
function speed(){return parseFloat($("speed").value)||1}
function ease(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2}
function place(p){var q=P(p.x,p.y);p.g.setAttribute("transform","translate("+q[0].toFixed(1)+","+(q[1]-8).toFixed(1)+")")}
function move(p,pts,ms){if(!Array.isArray(pts[0]))pts=[pts];var path=[[p.x,p.y]].concat(pts);
 if(instant){p.x=path[path.length-1][0];p.y=path[path.length-1][1];place(p);return}
 var segs=[],L=0;for(var i=1;i<path.length;i++){var d=Math.hypot(path[i][0]-path[i-1][0],path[i][1]-path[i-1][1]);segs.push(d);L+=d}
 tweens=tweens.filter(function(w){return w.p!==p});p.g.classList.remove("still");
 tweens.push({p:p,path:path,segs:segs,L:L||1,t0:performance.now(),ms:ms/speed()})}
function frame(now){tweens=tweens.filter(function(w){var t=Math.min(1,(now-w.t0)/w.ms),d=ease(t)*w.L,i=0;
 while(i<w.segs.length-1&&d>w.segs[i]){d-=w.segs[i];i++}var a=w.path[i],b=w.path[i+1],f=w.segs[i]?Math.min(1,d/w.segs[i]):1;
 w.p.x=a[0]+(b[0]-a[0])*f;w.p.y=a[1]+(b[1]-a[1])*f;place(w.p);if(t>=1){w.p.g.classList.add("still");return false}return true});requestAnimationFrame(frame)}
requestAnimationFrame(frame);
function rx(cls,seq,k,h){var d=document.createElement("div");d.className="ln "+(cls||"");d.innerHTML='<span class="s">'+(seq==null?"":"#"+seq)+'</span><span class="k">'+esc(k)+'</span><span class="h">'+esc(h||"")+'</span>';$("rx").appendChild(d);$("rx").scrollTop=1e6}
function led(cls,seq,label){var e=(sc.ledger||[])[seq];rx(cls,seq,label||(e?e.kind:"?"),e?e.hash.slice(0,8):"")}
function ledKind(cls,kind,label){(sc.ledger||[]).forEach(function(e){if(e.kind===kind)led(cls,e.seq,label)})}
function stat(i,v,c){var n=document.querySelectorAll(".st")[i];if(!n)return;n.querySelector("div").textContent=v;n.className="st "+(c||"")}
function stats(arr){$("stats").innerHTML=arr.map(function(a){return '<div class="st '+(a[2]||"")+'"><small>'+esc(a[0])+'</small><div>'+esc(a[1])+'</div></div>'}).join("")}
var lastPt=[500,300];svg.addEventListener("click",function(e){var r=$("mall").getBoundingClientRect();lastPt=[e.clientX-r.left,e.clientY-r.top]},true);
function det(h,quiet){var d=$("det");if(quiet)return;d.innerHTML='<button class="x" aria-label="close">×</button>'+h;d.hidden=false;var r=$("mall").getBoundingClientRect();d.style.left=Math.max(360,Math.min(r.width-320,lastPt[0]+18))+"px";d.style.top=Math.max(130,Math.min(r.height-260,lastPt[1]-40))+"px";d.querySelector(".x").onclick=function(){d.hidden=true}}
function short(s){return s?String(s).slice(0,12):"—"}
// ---------- the building (2.5D isometric) ----------
function P(x,y){return [(x-y)*0.53+390,(x+y)*0.265+150]}
function pts(a){return a.map(function(q){return q[0].toFixed(1)+","+q[1].toFixed(1)}).join(" ")}
function up(q,h){return [q[0],q[1]-h]}
function poly(g,a,fill,ex){var o={points:pts(a),fill:fill};for(var k in ex)o[k]=ex[k];return S("polygon",o,g)}
function box(g,x,y,w,d,H,top,left,right,st){var A=P(x,y),B=P(x+w,y),C=P(x+w,y+d),Dd=P(x,y+d),s=st||"#00000018";
 poly(g,[Dd,C,up(C,H),up(Dd,H)],left,{stroke:s});poly(g,[B,C,up(C,H),up(B,H)],right,{stroke:s});poly(g,[up(A,H),up(B,H),up(C,H),up(Dd,H)],top,{stroke:s})}
function shade(g,x,y,w,d,o){poly(g,[P(x+4,y+4),P(x+w+(o||16),y+4),P(x+w+(o||16),y+d+(o||16)*.6),P(x+4,y+d+(o||16)*.6)],"#3b2f2a",{opacity:.13})}
function faceText(g,x,y,u,h,txt,a){var q=up(P(x+u,y),h);var o={transform:"matrix(0.894,0.447,0,1,"+q[0].toFixed(1)+","+q[1].toFixed(1)+")","text-anchor":"middle"};for(var k in a)o[k]=a[k];return T(txt,o,g)}
function facePoly(g,x,y,u0,u1,h0,h1,fill,ex){return poly(g,[up(P(x+u0,y),h0),up(P(x+u1,y),h0),up(P(x+u1,y),h1),up(P(x+u0,y),h1)],fill,ex)}
var LAYER={};
function floor(){svg.innerHTML="";
 var df=S("defs");
 var sky=S("linearGradient",{id:"sky",x1:0,y1:0,x2:0,y2:1},df);S("stop",{offset:0,"stop-color":"#fde9c9"},sky);S("stop",{offset:1,"stop-color":"#f6f0e2"},sky);
 var gl=S("linearGradient",{id:"glass",x1:0,y1:0,x2:1,y2:1},df);S("stop",{offset:0,"stop-color":"#cfe8f3","stop-opacity":.5},gl);S("stop",{offset:1,"stop-color":"#9fc7da","stop-opacity":.18},gl);
 var lt=S("linearGradient",{id:"beam",x1:0,y1:0,x2:0,y2:1},df);S("stop",{offset:0,"stop-color":"#fff4c2","stop-opacity":.55},lt);S("stop",{offset:1,"stop-color":"#fff4c2","stop-opacity":0},lt);
 var gw=S("radialGradient",{id:"glow"},df);S("stop",{offset:0,"stop-color":"#ffd66b","stop-opacity":.7},gw);S("stop",{offset:1,"stop-color":"#ffd66b","stop-opacity":0},gw);
 S("rect",{x:0,y:0,width:1000,height:600,fill:"url(#sky)"});
 // lawn + plaza
 poly(null,[P(-40,-30),P(1040,-30),P(1040,640),P(-40,640)],"#dfe9cf");
 poly(null,[P(830,18),P(992,18),P(992,582),P(830,582)],"#d6d0c3");
 for(var j=0;j<8;j++){S("line",{x1:P(846,60+j*68)[0],y1:P(846,60+j*68)[1],x2:P(976,60+j*68)[0],y2:P(976,60+j*68)[1],stroke:"#fffbe9","stroke-width":1.6,"stroke-dasharray":"8 5"})}
 var pq=P(911,30);T("PARKING",{x:pq[0],y:pq[1]-4,"text-anchor":"middle","font-size":12,"font-weight":800,fill:"#7d7466","letter-spacing":3});
 // floor slab with thickness
 box(null,70,18,740,564,8,"#f5e7cd","#d9c19c","#cdb48f");
 var fl=S("g",{opacity:.5});for(var i=0;i<=740;i+=37){S("line",{x1:up(P(70+i,18),8)[0],y1:up(P(70+i,18),8)[1],x2:up(P(70+i,582),8)[0],y2:up(P(70+i,582),8)[1],stroke:"#e8d6b6"},fl)}
 for(var i2=0;i2<=564;i2+=37){S("line",{x1:up(P(70,18+i2),8)[0],y1:up(P(70,18+i2),8)[1],x2:up(P(810,18+i2),8)[0],y2:up(P(810,18+i2),8)[1],stroke:"#e8d6b6"},fl)}
 // back walls: two storeys with mezzanine shopfronts
 var bw=S("g");var WH=150;
 poly(bw,[up(P(70,18),8),up(P(810,18),8),up(P(810,18),WH),up(P(70,18),WH)],"#efd9b8",{stroke:"#c9ad86"});
 poly(bw,[up(P(70,18),8),up(P(70,582),8),up(P(70,582),WH),up(P(70,18),WH)],"#e4c9a2",{stroke:"#c9ad86"});
 for(var u=20;u<730;u+=46){var lit=(u/46|0)%3!==1;poly(bw,[up(P(70+u,18),88),up(P(70+u+34,18),88),up(P(70+u+34,18),128),up(P(70+u,18),128)],lit?"#ffe3a3":"#d8e6ea",{stroke:"#b99a70"});
  poly(bw,[up(P(70+u,18),128),up(P(70+u+34,18),128),up(P(70+u+34,18),134),up(P(70+u,18),134)],AWN[(u/46|0)%AWN.length])}
 poly(bw,[up(P(70,18),78),up(P(810,18),78),up(P(810,24),80),up(P(70,24),80)],"#b98d5c");
 for(var v=30;v<540;v+=46){var lit2=(v/46|0)%2===0;poly(bw,[up(P(70,18+v),88),up(P(70,18+v+34),88),up(P(70,18+v+34),128),up(P(70,18+v),128)],lit2?"#ffe7b0":"#d8e6ea",{stroke:"#b99a70"})}
 poly(bw,[up(P(70,18),78),up(P(70,582),78),up(P(76,582),80),up(P(76,18),80)],"#b98d5c");
 var lv=up(P(70,18),140);T("LEVEL 2 · mezzanine",{x:lv[0]+40,y:lv[1]+4,"font-size":9,fill:"#8a6a45","font-weight":700,"letter-spacing":1.5});
 // entrance doors on left wall
 poly(bw,[up(P(70,262),8),up(P(70,338),8),up(P(70,338),62),up(P(70,262),62)],"#a9d6e8",{stroke:"#5b8fa6","stroke-width":2});
 var en=up(P(70,300),70);T("ENTRANCE",{x:en[0],y:en[1],"text-anchor":"middle","font-size":10,"font-weight":800,fill:"#5b7a4f","letter-spacing":2});
 // info desk
 var dk=S("g");shade(dk,92,270,92,60,10);box(dk,92,270,92,60,18,"#fff4dc","#f1dcb6","#e2c79b");faceText(dk,92,330,46,8,"Fork & enroll",{"font-size":9.5,"font-weight":800,fill:"#6b4f33"});
 LAYER.shops=S("g");
 // checkout counters
 var co=S("g");poly(co,[up(P(600,150),9),up(P(796,150),9),up(P(796,450),9),up(P(600,450),9)],"#fbf1de",{stroke:"#d9b98a","stroke-dasharray":"5 4"});
 var ct=up(P(600,150),20);T("CHECKOUT · security gates",{x:ct[0]+70,y:ct[1]-2,"font-size":11,"font-weight":800,fill:"#7a5a3a","letter-spacing":1});
 Object.keys(GATES).forEach(function(gn,i){var y=172+i*82,b=S("g",{},co);shade(b,614,y,122,46,10);box(b,614,y,122,46,22,"#ffffff",["#f2cc8f","#b8d8c8","#c9d6ea"][i],"#e9dcc6");
  faceText(b,614,y+46,61,8,gn,{"font-size":10,"font-weight":800,fill:"#3b2f2a"});var lc=up(P(675,y+23),22);
  S("ellipse",{cx:lc[0],cy:lc[1]-6,rx:16,ry:9,fill:"url(#glow)",id:"glow"+i,opacity:0},b);S("circle",{id:"lamp"+i,cx:lc[0],cy:lc[1]-4,r:6,fill:"#e4d8c4",stroke:"#bfae94"},b);
  var gc=up(P(736,y+23),22);T(GATES[gn].length+" check"+(GATES[gn].length>1?"s":""),{x:gc[0]+8,y:gc[1]+4,"font-size":9,fill:"#8a7a6d"},b)});
 // quarantine room (walled)
 var q=S("g");poly(q,[up(P(600,470),9),up(P(796,470),9),up(P(796,570),9),up(P(600,570),9)],"#f6dcd6");
 poly(q,[up(P(600,470),9),up(P(796,470),9),up(P(796,470),48),up(P(600,470),48)],"#e9b3aa",{stroke:"#c0574e"});
 poly(q,[up(P(600,470),9),up(P(600,570),9),up(P(600,570),48),up(P(600,470),48)],"#e0a299",{stroke:"#c0574e"});
 var qt=up(P(600,470),56);T("QUARANTINE ROOM",{x:qt[0]+60,y:qt[1]+4,"font-size":11,"font-weight":800,fill:"#a1453d","letter-spacing":1.5});
 var qr=up(P(698,575),8);S("text",{id:"qreason",x:qr[0],y:qr[1]+16,"text-anchor":"middle","font-size":10,fill:"#a1453d","font-weight":700,"font-family":"ui-monospace,Menlo,monospace"});
 // glass atrium over the central court, with light beams
 var at=S("g",{"pointer-events":"none"});var ax=800,ay=140,aw=0,ad=320,AH=150;
 for(var b2=0;b2<4;b2++){var yy=ay+40+b2*110;poly(at,[up(P(ax-200,yy),AH),up(P(ax-160,yy),AH),up(P(ax+60,yy+60),8),up(P(ax-40,yy+60),8)],"url(#beam)")}
 poly(at,[up(P(ax-230,ay),AH),up(P(ax+aw,ay),AH),up(P(ax+aw,ay+ad),AH),up(P(ax-230,ay+ad),AH)],"url(#glass)",{stroke:"#7fa9bd","stroke-width":1.2});
 for(var r=0;r<=ad;r+=40)S("line",{x1:up(P(ax-230,ay+r),AH)[0],y1:up(P(ax-230,ay+r),AH)[1],x2:up(P(ax+aw,ay+r),AH)[0],y2:up(P(ax+aw,ay+r),AH)[1],stroke:"#ffffff",opacity:.55},at);
 [ay,ay+ad].forEach(function(yy){[ax-230,ax+aw].forEach(function(xx){var p0=up(P(xx,yy),8),p1=up(P(xx,yy),AH);S("line",{x1:p0[0],y1:p0[1],x2:p1[0],y2:p1[1],stroke:"#9c7f5c","stroke-width":2.5},at)})});
 var atl=up(P(ax-230,ay),AH+6);T("GLASS ATRIUM",{x:atl[0]+10,y:atl[1],"font-size":9,fill:"#5d8597","font-weight":800,"letter-spacing":2},at);
 LAYER.atrium=at;
 // exit doors and trees
 var ex=up(P(810,300),8);poly(null,[up(P(805,262),8),up(P(805,338),8),up(P(805,338),56),up(P(805,262),56)],"#a9d6e8",{stroke:"#5b8fa6","stroke-width":2});T("EXIT",{x:ex[0],y:ex[1]-54,"text-anchor":"middle","font-size":10,"font-weight":800,fill:"#5b7a4f"});
 [[30,40],[30,140],[30,460],[30,560],[200,610],[420,610],[640,610],[1010,200],[1010,420]].forEach(function(t,i){var b3=P(t[0],t[1]);S("ellipse",{cx:b3[0]+6,cy:b3[1]+3,rx:13,ry:5,fill:"#0002"});S("rect",{x:b3[0]-2,y:b3[1]-14,width:4,height:14,fill:"#8a6a45"});S("circle",{cx:b3[0],cy:b3[1]-22,r:12,fill:i%2?"#8fbf7f":"#a3c98a",stroke:"#6e9e60"});S("circle",{cx:b3[0]-4,cy:b3[1]-26,r:4,fill:"#c2e0ad"})});
 LAYER.fx=S("g");svg.appendChild(at);LAYER.people=S("g");
}
function drawShop(sh){var g=sh.g;while(g.firstChild)g.removeChild(g.firstChild);var x=sh.x,y=sh.y,w=sh.w,d=sh.d,L=sh.level,bad=sh.bad,c=bad?"#a99d90":AWN[sh.i%AWN.length];
 var H=24+L*14,front=y+d;shade(g,x,y,w,d,18);
 box(g,x,y,w,d,H,bad?"#d3cabe":"#fff7e8",bad?"#ddd2c4":"#fdf1dc",bad?"#c4b8aa":"#ecd8b8");
 var n=Math.max(2,Math.floor(w/30));for(var k=0;k<n;k++){var u0=8+k*(w-16)/n+3,u1=8+(k+1)*(w-16)/n-3;
  facePoly(g,x,front,u0,u1,4,H-15,bad?"#9a8f84":(L>=2?"#ffd987":(L>=1?"#d8e8ee":"#cfc6bb")),{stroke:"#a88a64","stroke-width":.8});
  if(bad){facePoly(g,x,front,u0-1,u1+1,(H-15)*.35,(H-15)*.35+4,"#8a6a45");facePoly(g,x,front,u0-1,u1+1,(H-15)*.65,(H-15)*.65+4,"#7a5c3c")}}
 if(L>=2&&!bad){var gq=up(P(x+w/2,front),H/2);S("ellipse",{cx:gq[0],cy:gq[1]+14,rx:w*.45,ry:12,fill:"url(#glow)",opacity:.8},g)}
 var st=Math.floor(w/14);for(var a=0;a<st;a++){var u2=a*w/st;poly(g,[up(P(x+u2,front),H-14),up(P(x+u2+w/st,front),H-14),up(P(x+u2+w/st,front+7),H-20),up(P(x+u2,front+7),H-20)],a%2?"#fffaf0":c,{stroke:"#0000000d"})}
 if(L>=3&&!bad){box(g,x+10,y+6,w-26,d-18,H+20,"#fffaf0","#fbecd2","#e8d1ae");var gq2=up(P(x+10,y+d-12),H+4);
  for(var m=0;m<n;m++)facePoly(g,x+10,y+d-12,8+m*(w-42)/n,8+(m+1)*(w-42)/n-4,H+4,H+14,"#ffe08f",{stroke:"#c9a36a","stroke-width":.6});
  var fp=up(P(x+w-24,y+10),H+20);S("line",{x1:fp[0],y1:fp[1],x2:fp[0],y2:fp[1]-22,stroke:"#7a5c3c","stroke-width":1.5},g);S("path",{d:"M"+fp[0]+" "+(fp[1]-22)+"l14 4l-14 5z",fill:"#e07a5f"},g)}
 var sgH=L>=3&&!bad?H+20:H;facePoly(g,x,front,10,w-10,sgH+2,sgH+17,bad?"#6f655c":"#3b2f2a");
 faceText(g,x,front,w/2,sgH+5.5,sh.name,{"font-size":9.5,fill:bad?"#cfc6bb":"#fff4dc","font-family":"ui-monospace,Menlo,monospace","font-weight":700});
 if(bad){poly(g,[up(P(x+4,front),H*.25),up(P(x+w-4,front),H*.75),up(P(x+w-4,front),H*.75+5),up(P(x+4,front),H*.25+5)],"#f2c230",{stroke:"#3b2f2a","stroke-dasharray":"5 5","stroke-width":1});
  poly(g,[up(P(x+4,front),H*.7),up(P(x+w-4,front),H*.2),up(P(x+w-4,front),H*.2+5),up(P(x+4,front),H*.7+5)],"#f2c230",{stroke:"#3b2f2a","stroke-dasharray":"5 5","stroke-width":1});
  var c0=up(P(x+w*.3,front),H-16),c1=up(P(x+w*.36,front),H*.5),c2=up(P(x+w*.31,front),H*.3);S("path",{d:"M"+pts([c0,c1,c2]).replace(/ /g," L"),fill:"none",stroke:"#5a4636","stroke-width":1.4},g)}
 Object.keys(sh.slots).forEach(function(f){var s=sh.slots[f],q=P(s[0],s[1]);var it=S("g",{opacity:sh.taken[f]?.25:1},g);
  poly(it,[[q[0]-6,q[1]-6],[q[0],q[1]-9],[q[0]+6,q[1]-6],[q[0],q[1]-3]],c);poly(it,[[q[0]-6,q[1]-6],[q[0],q[1]-3],[q[0],q[1]+4],[q[0]-6,q[1]+1]],bad?"#8c8177":"#00000030");poly(it,[[q[0]+6,q[1]-6],[q[0],q[1]-3],[q[0],q[1]+4],[q[0]+6,q[1]+1]],"#00000050");sh.items[f]=it});
 var lvl=["for lease","open","busy","landed ★"][L]||"";if(bad)lvl="quarantined";var lb=up(P(x+w,y),H);T(lvl,{x:lb[0]-4,y:lb[1]-4,"text-anchor":"end","font-size":8.5,"font-weight":800,fill:bad?"#a1453d":(L>=3?"#2f6e44":"#8a7a6d")},g)}
function setLevel(sh,L,bad){if(!sh)return;if(L!=null)sh.level=Math.max(sh.level,L);if(bad)sh.bad=true;drawShop(sh);if(!instant){sh.g.classList.remove("pop");void sh.g.getBBox();sh.g.classList.add("pop")}}
function shopAt(name,i,n,files){var cols=n>6?2:1,rows=Math.ceil(n/cols),col=cols===2?i%2:0,row=cols===2?Math.floor(i/2):i;
 var w=cols===2?172:340,h=Math.min(118,(520-(rows-1)*10)/rows),x=205+col*(w+14),y=36+row*(h+10)+(520-rows*(h+10)+10)/2,d=Math.max(28,h*.5);
 var g=S("g",{"class":"shop"},LAYER.shops);var sh={name:name,i:i,x:x,y:y,w:w,d:d,h:h,g:g,files:files,slots:{},items:{},taken:{},level:1,bad:false};
 files.forEach(function(f,j){var sx=files.length===1?x+w/2:x+22+j*((w-44)/(files.length-1));sh.slots[f]=[sx,y+d+10]});
 drawShop(sh);g.onclick=function(){showShop(sh)};shops[name]=sh;return sh}
function take(sh,f){if(!sh)return;sh.taken[f]=1;if(sh.items[f])sh.items[f].setAttribute("opacity",.25)}
function person(id,i,label){var g=S("g",{"class":"who still"},LAYER.people);var c=PAL[i%PAL.length];
 S("ellipse",{cx:2,cy:12,rx:8,ry:2.6,fill:"#0003"},g);
 var lg=S("g",{"class":"legs"},g);S("line",{x1:-2,y1:4,x2:-2,y2:11,stroke:"#4a3b33","stroke-width":2.6,"stroke-linecap":"round"},lg);S("line",{x1:2,y1:4,x2:2,y2:11,stroke:"#4a3b33","stroke-width":2.6,"stroke-linecap":"round"},lg);
 S("rect",{x:-6,y:-8,width:12,height:14,rx:5,fill:c},g);S("rect",{x:1,y:-7,width:4,height:12,rx:2,fill:"#ffffff30"},g);S("circle",{cx:0,cy:-13,r:5.5,fill:"#f3c9a5",stroke:"#d9a882"},g);S("path",{d:"M-5.5 -14a5.5 5.5 0 0 1 11 0z",fill:["#4a3b33","#a0522d","#2b2b2b","#d9a441"][i%4]},g);
 var bag=S("g",{opacity:0},g);S("rect",{x:6,y:-3,width:8,height:9,rx:1.5,fill:"#f2cc8f",stroke:"#b98f4f"},bag);S("path",{d:"M8 -3v-2h4v2",fill:"none",stroke:"#b98f4f"},bag);
 T(label||id,{x:0,y:24,"text-anchor":"middle","font-size":9.5,"font-weight":700,fill:"#3b2f2a",stroke:"#fffaf0","stroke-width":3,"paint-order":"stroke"},g);
 var p={id:id,g:g,x:20,y:300,bag:bag,color:c};place(p);g.onclick=function(){showAgent(id)};people[id]=p;return p}
function flagAt(x,y,txt,color,lift){var q=up(P(x,y),lift||40);var g=S("g",{"class":"pop"},LAYER.fx);var gg=S("g",{"class":"flag"},g);var w=txt.length*5.8+14;
 S("rect",{x:q[0]-w/2,y:q[1]-22,width:w,height:17,rx:8,fill:color||"#e0a43a"},gg);T(txt,{x:q[0],y:q[1]-10,"text-anchor":"middle","font-size":10,"font-weight":800,fill:"#fff"},gg);return g}
function lamp(i,ok){var l=$("lamp"+i);if(l)l.setAttribute("fill",ok?"#4f9d69":"#d2544c");var g=$("glow"+i);if(g)g.setAttribute("opacity",ok?1:0)}
function lampsReset(){for(var i=0;i<3;i++){var l=$("lamp"+i);if(l)l.setAttribute("fill","#e4d8c4");var g=$("glow"+i);if(g)g.setAttribute("opacity",0)}}
function car(color,sha,laneY){var g=S("g",{"class":"pop"},LAYER.people);S("ellipse",{cx:3,cy:12,rx:24,ry:6,fill:"#0003"},g);S("rect",{x:-20,y:-11,width:40,height:20,rx:7,fill:color},g);S("rect",{x:-12,y:-18,width:22,height:10,rx:4,fill:color},g);S("rect",{x:-9,y:-16,width:16,height:7,rx:2,fill:"#dff1fb"},g);
 [[-12,9],[12,9]].forEach(function(w){S("circle",{cx:w[0],cy:w[1],r:4,fill:"#333"},g)});
 T(sha,{x:0,y:28,"text-anchor":"middle","font-size":10,"font-weight":800,fill:"#3b2f2a",stroke:"#f6f0e2","stroke-width":3,"paint-order":"stroke","font-family":"ui-monospace,Menlo,monospace"},g);
 var p={g:g,x:880,y:laneY};place(p);return p}
function gateNames(ev){var o={};Object.keys(GATES).forEach(function(k){o[k]=GATES[k].every(function(n){return ev.gates[n]!==false})});return o}
// ---------- details ----------
function showAgent(id){if(!sc.agents)return;var a=sc.agents.filter(function(x){return x.id===id})[0];if(!a)return;
 var ev=(sc.evals||[]).filter(function(e){return e.agent===id})[0];var ov=(sc.overlaps||[]).filter(function(o){return o.a===id||o.b===id});
 var h='<h3>🛍 '+esc(a.id)+'</h3><div class="row"><b>role</b>'+esc(a.role)+'</div><div class="row"><b>intent</b>'+esc(a.intent)+'</div><div class="row"><b>claimed</b><span class="mono">'+(a.paths.length?a.paths.map(esc).join(", "):"(hosts the fork)")+'</span></div><div class="row"><b>commit</b><span class="mono">'+esc(a.commit||"—")+'</span></div>';
 if(ov.length)h+='<div class="row"><b>overlaps</b>'+ov.map(function(o){return esc(o.a+" ∩ "+o.b)+' <span class="chip">'+o.risk+'</span>'}).join("<br>")+'</div>';
 if(ev)h+='<div class="row"><b>gates</b>'+Object.keys(ev.gates).map(function(k){return '<span class="chip '+(ev.gates[k]?"p":"f")+'">'+k+'</span>'}).join("")+'</div>';
 if(sc.quarantine&&sc.quarantine.agent===id)h+='<div class="row" style="color:var(--bad)"><b>quarantine</b>'+esc(sc.quarantine.trigger)+' · evidence '+esc(sc.quarantine.evidence)+'</div>';
 h+='<div class="row" style="color:var(--dim);font-size:11px">source: '+esc(sc.intents_source||"")+'</div>';det(h)}
function showShop(sh){var who=(sc.agents||[]).filter(function(a){return a.paths.some(function(p){return sh.files.indexOf(p)>=0})});
 var h='<h3>🏬 '+esc(sh.name)+'</h3><div class="row"><b>shelf</b><span class="mono">'+sh.files.map(esc).join("<br>")+'</span></div><div class="row"><b>shoppers</b>'+(who.map(function(a){return esc(a.id)}).join(", ")||"—")+'</div>';
 var fz=(D.files||[]).filter(function(f){return dirOf(f.p)===sh.name.replace(/\/$/,"")}).length;if(fz)h+='<div class="row"><b>stock</b>'+fz+' existing file(s) in ky@'+esc(D.ky_commit.slice(0,8))+'</div>';det(h)}
function dirOf(p){var i=p.lastIndexOf("/");return i<0?"(root)":p.slice(0,i)}
// ---------- scenarios ----------
function W(ms,fn){steps.push({ms:ms,fn:fn||function(){}})}
function common(){floor();people={};shops={};tweens=[];steps=[];si=0;promoted=false;verdict=false;$("rx").innerHTML="";$("approve").disabled=true;$("refuse").textContent="";
 $("rxsub").innerHTML=esc(sc.task)+"<br>"+esc(sc.repo||"")}
function buildShops(agents,extra){var dirs={};agents.forEach(function(a){a.paths.forEach(function(p){var d=dirOf(p);(dirs[d]=dirs[d]||[]);if(dirs[d].indexOf(p)<0)dirs[d].push(p)})});
 var names=Object.keys(dirs);names.forEach(function(d,i){shopAt(d==="(root)"?"(root)":d+"/",i,names.length,dirs[d])});return dirs}
function shopOf(p){return shops[dirOf(p)==="(root)"?"(root)":dirOf(p)+"/"]}
function crew(){var A=sc.agents,ev=sc.evals[0];buildShops(A);
 stats([["agents",A.length,""],["shops visited",Object.keys(shops).length,""],["overlaps flagged",sc.overlaps.length,"amb"],["composed",sc.composed,""],["TheUstad",sc.ustad,"ok"],["promoted",short(sc.summary.promoted_sha),"ok"]]);
 $("legend").innerHTML="Floor plan &amp; walking are a <b>visualization</b>; agents, files, overlaps, gates, ledger &amp; SHAs are <b>REAL</b> (recorded run).";
 A.forEach(function(a,i){person(a.id,i,a.id.replace(/^sub-/,""))});
 W(400,function(){led("",0);led("",1);led("",2)});
 W(1300,function(){move(people.parent,[[138,330]],1100);rx("note",null,"parent forks ext-ky once","fork")});
 W(900,function(){ledKind("ok","agents_enrolled","agents_enrolled · "+A.length)});
 A.slice(1).forEach(function(a,i){var f=a.paths[0],sh=shopOf(f),s=sh.slots[f];W(260,function(){var p=people[a.id];p.y=270+((i*7)%60);place(p);move(p,[[110,p.y],[190,s[1]+18],[s[0]+(i%2?8:-8),s[1]+18]],1900)})});
 W(1700,function(){ledKind("","claim_registered","claim_registered");A.slice(1).forEach(function(a){var sh=shopOf(a.paths[0]);take(sh,a.paths[0]);setLevel(sh,2);people[a.id].bag.setAttribute("opacity",1)})});
 W(1500,function(){var seen={};sc.overlaps.forEach(function(o){var sub=o.a==="parent"?o.b:o.a,ag=A.filter(function(x){return x.id===sub})[0];if(!ag)return;var sh=shopOf(ag.paths[0]);if(seen[sh.name])return;seen[sh.name]=1;
   flagAt(sh.x+sh.w-14,sh.y+4,"⚠ overlap ×"+sc.overlaps.filter(function(q){var s2=q.a==="parent"?q.b:q.a;var g=A.filter(function(x){return x.id===s2})[0];return g&&shopOf(g.paths[0])===sh}).length,"#e0a43a",sh.level>=3?84:64)});
  rx("amb",null,sc.overlaps.length+" overlaps flagged (each sub ∩ parent fork scope)","AMBER")});
 W(2000,function(){A.forEach(function(a,i){move(people[a.id],[[580,150+((i*23)%300)],[748,180+(i%3)*82+20]],1800)});ledKind("","composition_recorded","composition_recorded · "+sc.composed)});
 W(1200,function(){ledKind("","contender_registered");ledKind("","evaluation_submitted","evaluation_submitted · "+short(ev.sha))});
 Object.keys(GATES).forEach(function(g,i){W(800,function(){lamp(i,gateNames(ev)[g]);rx("ok",null,g+": "+GATES[g].join(", ")+" ✓","pass")})});
 W(1000,function(){ledKind("","verifier_committed");ledKind("","verifier_revealed");ledKind("","verifier_report_submitted");ledKind("ok","verdict_reached","verdict_reached · "+short(ev.sha));verdict=true;$("approve").disabled=false;rx("ok",null,"TheUstad: "+sc.ustad,"")});
 W(900,function(){promote()});
 W(3200,function(){});
}
function promote(){if(promoted)return;promoted=true;$("approve").disabled=true;var s=sc.summary,w=s.promoted_sha;
 (sc.agents||[]).forEach(function(a,i){var p=people[a.id];if(!p||(sc.quarantine&&sc.quarantine.agent===a.id)||p.turned)return;move(p,[[813,300],[850+((i%4)*28),90+Math.floor(i/4)*36]],1800)});
 var ev=(sc.evals||[]).filter(function(e){return e.sha===w})[0];if(ev)ev.changed.forEach(function(f){if(f.indexOf(".madgrix/")===0)return;var sh2=shopOf(f);if(sh2&&!sh2.bad)setLevel(sh2,3)});rx("ok",null,"stores where work landed upgraded ★","upgrade");var c=car("#e07a5f",short(w),300);move(c,[[911,300],[911,40],[911,-60]],3200);
 ledKind("ok","permit_issued","permit_issued · "+String(s.permit_id).slice(0,10));ledKind("ok","promotion_reserved");ledKind("ok","promotion_succeeded","promotion_succeeded · "+short(w));
 if(sc.id==="cheater"){rx("ok",null,"offline verify (honest bundle): VERIFIED","");rx("bad",null,"tampered copy: "+sc.tamper_verify,"")}
 rx("ok",null,"drove off with "+short(w),"promoted")}
function cheater(){var A=sc.agents,byA={};sc.evals.forEach(function(e){byA[e.agent]=e});buildShops(A);
 var ana=byA["honest-ana"],fay=byA["false-done-fay"],cal=byA["cheater-cal"];
 stats([["shoppers",A.length,""],["same-shelf overlaps",sc.overlaps.length,"amb"],["quarantined","cheater-cal","bad"],["turned back","false-done-fay","amb"],["promoted",short(sc.summary.promoted_sha),"ok"],["tampered bundle","NOT VERIFIED","bad"]]);
 $("legend").innerHTML="Floor plan &amp; walking are a <b>visualization</b>; agents, files, gates, quarantine reason, ledger &amp; SHAs are <b>REAL</b>.";
 A.forEach(function(a,i){person(a.id,i)});var hs=shopOf("source/MADGRIX_HONEST.md"),ts=shopOf("test/base-url.ts"),slot=hs.slots["source/MADGRIX_HONEST.md"];
 W(400,function(){led("",0);led("",1);led("",2)});
 A.forEach(function(a,i){W(500,function(){var p=people[a.id];p.y=285+i*14;place(p);move(p,[[138,330+i*6],[190,slot[1]+20],[slot[0]-26+i*26,slot[1]+20]],2000)})});
 W(1900,function(){ledKind("ok","agents_enrolled","agents_enrolled · 3");ledKind("","claim_registered","claim_registered");take(hs,"source/MADGRIX_HONEST.md");setLevel(hs,2);
  flagAt(hs.x+hs.w-40,hs.y+4,"⚠ 3 at one shelf · overlap ×"+sc.overlaps.length,"#e0a43a",66);rx("amb",null,"overlap: all three claim source/MADGRIX_HONEST.md","AMBER")});
 W(1500,function(){people["honest-ana"].bag.setAttribute("opacity",1);var tsl=ts.slots["test/base-url.ts"];move(people["cheater-cal"],[[190,tsl[1]+20],[tsl[0],tsl[1]+20]],1600);rx("bad",null,"cheater-cal sneaks to test/ and edits test/base-url.ts","eval file")});
 W(1800,function(){take(ts,"test/base-url.ts");people["cheater-cal"].bag.setAttribute("opacity",1);
  move(people["false-done-fay"],[[580,260],[748,372]],1700);move(people["honest-ana"],[[580,220],[748,290]],1800);move(people["cheater-cal"],[[580,200],[748,206]],2000)});
 W(2100,function(){ledKind("","contender_registered");ledKind("","evaluation_submitted","evaluation_submitted")});
 // cheater at the door: guard
 W(1200,function(){lamp(0,false);var gd=person("guard",9,"security");gd.x=800;gd.y=470;place(gd);move(gd,[[770,214]],900);
  rx("bad",null,"Blind eval: no_eval_tampering ✗, scope_compliance ✗, security_policy ✗","fail")});
 W(1300,function(){move(people["cheater-cal"],[[698,535]],1600);move(people.guard,[[730,530]],1600);led("bad",19,"contender_quarantined · cheater-cal");
  rx("bad",null,"reason: "+sc.quarantine.trigger+" (evidence "+sc.quarantine.evidence+")","#19");$("qreason").textContent=sc.quarantine.trigger+" · test/base-url.ts";setLevel(ts,null,true);rx("bad",null,"store test/ boarded up: eval file tampered","degrade")});
 W(1600,function(){lamp(1,false);flagAt(700,300,"hidden tests ✗","#d2544c");rx("bad",null,"false-done-fay: hidden_oracle ✗, regressions ✗ (said done, wrote nothing)","fail")});
 W(1300,function(){people["false-done-fay"].turned=true;move(people["false-done-fay"],[[560,380],[330,470]],2000);rx("amb",null,"false-done-fay turned back at checkout","no bag")});
 W(1200,function(){lampsReset();var g=gateNames(ana);Object.keys(GATES).forEach(function(k,i){lamp(i,g[k])});rx("ok",null,"honest-ana: all 9 gates ✓ ("+short(ana.sha)+")","pass")});
 W(1200,function(){ledKind("","verifier_revealed");ledKind("","verifier_report_submitted");ledKind("ok","verdict_reached","verdict_reached · winner "+short(sc.summary.winner));verdict=true;$("approve").disabled=false});
 W(900,function(){promote()});
 W(3500,function(){});
}
function scale(){var s=sc;steps=[];
 stats([["claims granted",s.granted.toLocaleString(),"ok"],["overlaps flagged",s.overlaps_flagged+" / "+s.seeded_overlaps,"amb"],["false flags",s.false_flags,"ok"],["p50 / p95 ms",s.p50+" / "+s.p95,""],["claims/s",s.claims_per_s,""],["ledger chain",(s.ledger_entries||"")+" · "+(s.chain_ok?"OK":"FAIL"),s.chain_ok?"ok":"bad"]]);
 $("legend").innerHTML="Crowd is a <b>visualization</b> (300 figures stand for 3,000 claims); every counter is <b>REAL</b> from the recorded run. "+esc(s.note);
 var names=["agents/a1-500/","agents/a501-1000/","agents/a1001-1500/","agents/a1501-2000/","agents/a2001-2500/","agents/a2501-3000/"];
 names.forEach(function(n,i){shopAt(n,i,6,[])});
 var crowd=LAYER.people,dots=[],counter=T("0 claims",{x:860,y:70,"text-anchor":"middle","font-size":26,"font-weight":800,fill:"#3b2f2a","font-family":"Georgia,serif"}),ovc=T("0 overlaps flagged",{x:860,y:92,"text-anchor":"middle","font-size":13,"font-weight":700,fill:"#b07a17"});
 for(var i=0;i<300;i++){var c=PAL[i%PAL.length],g=S("g",{},crowd);S("circle",{cx:0,cy:-5,r:3,fill:"#f3c9a5"},g);S("rect",{x:-3,y:-2,width:6,height:7,rx:2.5,fill:c},g);var p={g:g,x:20,y:260+Math.random()*80,i:i,ov:(i%20===0)};place(p);dots.push(p)}
 rx("",0,"authority_created","");rx("note",null,"3,000 agents each claim agents/aN/**","");
 var b=0;for(var k=0;k<10;k++)(function(k){W(1100,function(){for(var j=k*30;j<k*30+30;j++){var p=dots[j],sh=shops[names[j%6]];var tx=sh.x+10+Math.random()*(sh.w-20),ty=sh.y+sh.d+6+Math.random()*(sh.h-sh.d-12);
  if(instant){p.x=tx;p.y=ty;place(p)}else move(p,[[150,280+Math.random()*40],[tx,ty]],1500+Math.random()*900);
  if(p.ov){var fq=P(tx,ty);S("circle",{cx:fq[0],cy:fq[1]-26,r:4,fill:"#e0a43a","class":"pop"},LAYER.fx)}}
  names.forEach(function(nm){setLevel(shops[nm],k>=8?3:(k>=3?2:1))});
  var n=Math.round(s.granted*(k+1)/10),o=Math.round(s.overlaps_flagged*(k+1)/10);counter.textContent=n.toLocaleString()+" claims";ovc.textContent=o+" overlaps flagged";
  rx(k===9?"ok":"",null,"claim_registered × "+(n-b).toLocaleString()+" (Σ "+n.toLocaleString()+")","");b=n})})(k);
 W(1200,function(){rx("amb",null,s.overlaps_flagged+" of "+s.seeded_overlaps+" seeded overlaps flagged · "+s.false_flags+" false flags","");rx(s.chain_ok?"ok":"bad",null,"ledger: "+s.ledger_entries+" entries · hash chain "+(s.chain_ok?"OK":"FAIL"),"");rx("",null,"errors: "+s.errors+" · p50 "+s.p50+" ms · p95 "+s.p95+" ms","")});
 W(3000,function(){});
 $("approve").disabled=true}
// ---------- REAL-TIME mode: polls GET /tasks/:id/board-state (read-only) ----------
var LIVE={on:false,ids:[],cur:null,seen:{},sig:"",t:null};
function liveIds(){var q=new URLSearchParams(location.search).get("task");var ids=q?q.split(",").filter(Boolean):[];
 D.scenarios.forEach(function(x){if(x.task&&ids.indexOf(x.task)<0&&x.id!=="scale")ids.push(x.task)});return ids}
function startLive(id){stop();LIVE.on=true;LIVE.ids=liveIds();LIVE.cur=id||LIVE.cur||LIVE.ids[0];LIVE.sig="";
 document.querySelectorAll(".sc button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.id==="live")});
 $("badge").textContent="LIVE · polling real task state";$("badge").className="badge real";poll()}
function poll(){clearTimeout(LIVE.t);if(!LIVE.on)return;var id=LIVE.cur;
 fetch("/tasks/"+encodeURIComponent(id)+"/board-state",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){if(!LIVE.on||id!==LIVE.cur)return;renderLive(s)})
 .catch(function(e){rx("bad",null,"poll failed: "+e,"")}).then(function(){LIVE.t=setTimeout(poll,4000)})}
function renderLive(s){var sig=JSON.stringify([s.counts,s.status,(s.contenders||[]).map(function(c){return c.status+c.commit}),(s.evaluations||[]).length]);if(sig===LIVE.sig){$("lpoll").textContent="last poll "+new Date().toLocaleTimeString();return}LIVE.sig=sig;
 var agents={},order=[];function A(id){if(!agents[id]){agents[id]={id:id,role:"enrolled",intent:"(live) claimed paths below",paths:[],commit:null};order.push(id)}return agents[id]}
 (s.claims||[]).forEach(function(c){var a=A(c.agent);c.paths.forEach(function(p){if(a.paths.indexOf(p)<0)a.paths.push(p)})});
 var byC={};(s.contenders||[]).forEach(function(c){var a=A(c.agent);a.role=c.status;a.commit=c.commit?c.commit.slice(0,12):null;byC[c.contender]=a});
 var evals=(s.evaluations||[]).map(function(e){var a=byC[e.contender];return {sha:e.sha,contender:e.contender,gates:e.gates,agent:a?a.id:e.contender,changed:a?a.paths:[]}});
 var promoted=s.status==="promoted"&&s.verdict&&s.verdict.winner;
 sc={id:"live",label:"Live",badge:"REAL",task:s.task_id,repo:s.repo||"live task",agents:order.slice(0,60).map(function(k){return agents[k]}),evals:evals,overlaps:[],ledger:[],intents_source:"GET /tasks/"+s.task_id+"/board-state (live)",summary:{promoted_sha:promoted||null}};
 var q=(sc.agents.filter(function(a){return a.role==="quarantined"})[0]);sc.quarantine=q?{agent:q.id,trigger:"contender_quarantined (see ledger)",evidence:""}:null;
 common();
 var tabs='<div class="row">'+LIVE.ids.map(function(t){return '<button class="chip'+(t===LIVE.cur?' p':'')+'" data-lt="'+esc(t)+'" style="border:0;cursor:pointer">'+esc(t.slice(0,14))+'…</button>'}).join(" ")+'</div><div class="row" style="font-size:11px;color:var(--dim)">Add tasks with ?live=1&amp;task=&lt;id&gt;. There is no public task index; these are the watched ids.</div><div class="row" id="lpoll" style="font-size:11px;color:var(--dim)"></div>';
 det('<h3>● Live: '+esc(s.task_id)+'</h3><div class="row"><b>status</b>'+esc(s.status)+'</div><div class="row"><b>counts</b>'+s.counts.claims+' claims · '+s.counts.contenders+' forks · '+s.counts.evaluations+' evals · '+s.counts.ledger+' ledger</div>'+tabs);
 document.querySelectorAll("[data-lt]").forEach(function(b){b.onclick=function(){startLive(b.dataset.lt)}});
 if(sc.agents.some(function(a){return a.paths.length}))buildShops(sc.agents.slice(0,60).map(function(a){return {paths:a.paths.slice(0,3)}}).slice(0,10));
 stats([["status",s.status||"—",s.status==="promoted"?"ok":""],["forks",s.counts.contenders,""],["claims",s.counts.claims,""],["evaluations",s.counts.evaluations,""],["quarantined",sc.agents.filter(function(a){return a.role==="quarantined"}).length,"bad"],["promoted",promoted?short(promoted):"—",promoted?"ok":""]]);
 $("legend").innerHTML="<b>LIVE</b>: every agent, path, gate and ledger line is polled from the real task every 4 s; the building and walking are a visualization.";
 (s.ledger||[]).forEach(function(e){rx(/quarantin|fail|reject/.test(e.kind)?"bad":(/promotion_succeeded|verdict/.test(e.kind)?"ok":""),e.seq,e.kind,e.hash.slice(0,8))});
 sc.agents.forEach(function(a,i){var p=person(a.id,i,a.id.length>14?a.id.slice(0,13)+"…":a.id);var isNew=!LIVE.seen[s.task_id+a.id];LIVE.seen[s.task_id+a.id]=1;
  var f=a.paths[0],sh=f?shopOf(f):null,tgt=sh&&sh.slots[f]?[sh.slots[f][0]+((i%3)-1)*12,sh.slots[f][1]+18]:[150,280+(i%8)*12];
  var ev=evals.filter(function(e){return e.agent===a.id})[0],ok=ev&&Object.keys(ev.gates).every(function(k){return ev.gates[k]});
  if(a.role==="quarantined"){tgt=[640+(i%4)*30,520];setLevel(sh,null,true);$("qreason").textContent="quarantined: "+a.id}
  else if(promoted&&ev&&ev.sha===promoted){tgt=[860+(i%4)*28,90+Math.floor(i/4)*36];p.bag.setAttribute("opacity",1);a.paths.forEach(function(pp){setLevel(shopOf(pp),3)})}
  else if(ev){tgt=[748,180+(i%3)*82+20];if(!ok){var gn=gateNames(ev);Object.keys(GATES).forEach(function(k,j){lamp(j,gn[k])})}}
  else if(sh){setLevel(sh,2);take(sh,f)}
  if(isNew){p.x=20;p.y=300;place(p);move(p,[[138,320],tgt],2200)}else{p.x=tgt[0];p.y=tgt[1];place(p)}});
 if(promoted){car("#e07a5f",short(promoted),300);verdict=true}
}
// ---------- engine ----------
function load(id){if(id==="live")return startLive();LIVE.on=false;clearTimeout(LIVE.t);stop();sc=D.scenarios.filter(function(x){return x.id===id})[0]||D.scenarios[0];
 document.querySelectorAll(".sc button").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.id===sc.id)});
 $("badge").textContent=sc.badge+" data · illustrated";$("badge").className="badge "+(sc.badge==="REAL"?"real":"viz");
 common();({crew:crew,cheater:cheater,scale:scale})[sc.id]();
 $("det").hidden=true;det('<h3>'+esc(sc.label)+'</h3><div class="row"><b>task</b><span class="mono">'+esc(sc.task)+'</span></div><div class="row" style="color:var(--dim)">Click a shop (directory) or a shopper (agent) for the recorded details.</div>',true)}
function step(){if(si>=steps.length){if($("loop").checked&&playing){var id=sc.id;load(id);playing=true;$("play").textContent="❚❚ Pause"}else{stop();return}}
 var s=steps[si++];s.fn();if(playing)timer=setTimeout(step,s.ms/speed())}
function runTo(n){instant=true;tweens=[];while(si<n&&si<steps.length)steps[si++].fn();instant=false;Object.keys(people).forEach(function(k){people[k].g.classList.add("still")})}
function play(){if(si>=steps.length)load(sc.id);playing=true;$("play").textContent="❚❚ Pause";step()}
function stop(){playing=false;clearTimeout(timer);$("play").textContent="▶ Play"}
$("play").onclick=function(){playing?stop():play()};$("restart").onclick=function(){load(sc.id)};
$("approve").onclick=function(){if(!verdict||promoted)return;rx("note",null,"Approve: replaying the recorded promotion (no live call)","");promote()};
$("override").onclick=function(){$("refuse").textContent="Refused: mandatory gates cannot be waived"};
(function(){var b=document.createElement("button");b.textContent="● Live";b.dataset.id="live";b.onclick=function(){startLive()};$("sc").appendChild(b)})();
D.scenarios.forEach(function(x){var b=document.createElement("button");b.textContent=x.label;b.dataset.id=x.id;b.onclick=function(){load(x.id)};$("sc").appendChild(b)});
var qs=new URLSearchParams(location.search);if(qs.get("speed"))$("speed").value=qs.get("speed");if(qs.get("loop")==="1")$("loop").checked=true;
if(qs.get("live")==="1"||!qs.get("scenario")){startLive()}else load(qs.get("scenario"));if(qs.get("step")){document.body.classList.add("static");runTo(parseInt(qs.get("step"),10)||0)}if(qs.get("agent"))showAgent(qs.get("agent"));if(qs.get("shop")&&shops[qs.get("shop")])showShop(shops[qs.get("shop")]);if(!qs.get("step")&&!LIVE.on&&qs.get("autoplay")==="1")play();
window.__board={runTo:runTo,steps:function(){return steps.length},load:load,showAgent:showAgent,showShop:function(n){showShop(shops[n])}};
})();
</script></body></html>`;
