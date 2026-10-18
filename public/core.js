(function(root){
/* ===== 出厂自带的全局规则 =====
   新装的浏览器直接带上；老配置在下次读取时补一次（用独立的 cardflow.rulesSeed 标记，只补一次——
   用户之后在全局设置里删掉/改写就不会再被自动加回来）。 */
const DEFAULT_RULES=[
{id:'occlusion-merge',enabled:true,text:'遮挡卡：同一张图上的多个遮挡区域合并成一张卡（所有区域在同一次遮挡里一起遮住），不要按遮挡区域拆成多张卡。'},
{id:'cloze-single-number',enabled:true,text:'填空卡：同一张卡可以出现多个 {{c1::…}} 填空，但只能使用 c1，绝不能出现 c2、c3 等其它编号。'}];
const RULES_SEED_KEY='cardflow.rulesSeed';
const defaults={rules:DEFAULT_RULES.map(r=>({...r})),batchSize:2,documentPreset:'standard',visual:true,answerLimit:350,questionLimit:180,duplicateCheck:true,showSources:true};
function readStore(){try{const raw=JSON.parse(localStorage.getItem('cardflow.settings')||'{}');return raw&&typeof raw==='object'?raw:{};}catch(_){return {};}}
function settings(){try{
const raw=readStore();
const seeded=localStorage.getItem(RULES_SEED_KEY)==='1';
const x={...defaults,...raw};
let rules=Array.isArray(x.rules)?x.rules.filter(r=>r&&typeof r.text==='string'):[];
if(!seeded){const known=new Set(rules.map(r=>String(r.text||'').trim()));DEFAULT_RULES.forEach(r=>{if(!known.has(r.text))rules.push({...r});});}
x.rules=rules.slice(0,30);
x.batchSize=Math.max(1,Math.min(25,Math.floor(Number(x.batchSize)||2)));
if(!['tiny','small','medium','sharp','standard','large','raw'].includes(x.documentPreset))x.documentPreset='standard';
if(!seeded){try{localStorage.setItem(RULES_SEED_KEY,'1');localStorage.setItem('cardflow.settings',JSON.stringify({...raw,rules:x.rules}));}catch(_){}}
return x;}catch(_){return {...defaults,rules:DEFAULT_RULES.map(r=>({...r}))};}}
function normalize(s){return String(s||'').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');}
function quality(cards,options=defaults,previous=[]){const seen=new Set(previous.map(normalize));return cards.map(c=>{const q=c.text||c.front||c.prompt||'';const key=normalize(q);const out=[];if(options.duplicateCheck&&key&&seen.has(key))out.push('重复：与当前或此前批次问题相同');if(key)seen.add(key);if(q.length>options.questionLimit)out.push('问题过长，建议拆分');if(String(c.back||c.note||'').length>options.answerLimit)out.push('答案过载，建议拆分');return out;});}
function issue(c,options){if(c.type==='audio'){if(!c.front?.trim()||!c.back?.trim())return '音频卡缺少正面或背面';if(!/^data:audio\/(mpeg|mp3|wav|ogg);base64,[A-Za-z0-9+/=]+$/.test(c.audio||'')&&!(options&&options.allowSynth))return '音频卡需提供 MP3/WAV/OGG 的 base64 data URL（服务端会自动配音时可以不填）';}
if(c.type==='occlusion'){if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(c.image||''))return '遮挡卡缺少内嵌图片';if(!Array.isArray(c.masks)||!c.masks.length||c.masks.length>40)return '遮挡卡需有 1–40 个矩形';for(const m of c.masks)if(![m.x,m.y,m.w,m.h].every(Number.isFinite)||m.x<0||m.y<0||m.w<=0||m.h<=0||m.x+m.w>1||m.y+m.h>1)return '遮挡区域使用 0–1 归一化坐标，且不得越界';}return '';}
/* ===== 遮挡框（0–1 归一化矩形）：全部用这四个纯函数，编辑器与校验共用一套口径 ===== */
/** 遮挡框坐标夹取。mode='move' 时优先保尺寸（拖到边上就停下），默认优先保位置（缩放时不越界）。 */
const MASK_MIN = 0.02;
function clampMask(mask, mode){
const num=(v,fallback)=>Number.isFinite(Number(v))?Number(v):fallback;
const clamp=(v,min,max)=>Math.min(Math.max(v,min),max);
let x=num(mask&&mask.x,0), y=num(mask&&mask.y,0), w=num(mask&&mask.w,0), h=num(mask&&mask.h,0);
if(mode==='move'){w=clamp(w,MASK_MIN,1);h=clamp(h,MASK_MIN,1);x=clamp(x,0,1-w);y=clamp(y,0,1-h);}
else{x=clamp(x,0,1-MASK_MIN);y=clamp(y,0,1-MASK_MIN);w=clamp(w,MASK_MIN,1-x);h=clamp(h,MASK_MIN,1-y);}
const round=v=>Number(v.toFixed(4));
return {x:round(x),y:round(y),w:round(w),h:round(h)};}
function moveMask(mask,dx,dy){return clampMask({...mask,x:(Number(mask&&mask.x)||0)+dx,y:(Number(mask&&mask.y)||0)+dy},'move');}
function resizeMask(mask,dx,dy){return clampMask({...mask,w:(Number(mask&&mask.w)||0)+dx,h:(Number(mask&&mask.h)||0)+dy});}
function maskFromDrag(startX,startY,endX,endY){return clampMask({x:Math.min(startX,endX),y:Math.min(startY,endY),w:Math.abs(endX-startX),h:Math.abs(endY-startY)});}
const api={defaults,DEFAULT_RULES,settings,normalize,quality,issue,clampMask,moveMask,resizeMask,maskFromDrag,MASK_MIN};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CardFlowCore=api;
})(typeof window!=='undefined'?window:globalThis);
