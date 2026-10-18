/* 文档句柄只读；仅当前批次渲染到内存。 */
(function(){
const PRESETS={tiny:{label:'省流最小',edge:1024,quality:.60},small:{label:'小图',edge:1600,quality:.70},medium:{label:'偏小',edge:2400,quality:.80},sharp:{label:'偏清晰',edge:2400,quality:.85},standard:{label:'标准',edge:2400,quality:.92},large:{label:'更清晰',edge:3200,quality:.92},raw:{label:'不压缩',edge:3200,quality:.98}};
async function open(file){
 if(file.size>512*1024*1024)throw Error('文件超过 512MB；建议先分卷，手机可用内存可能更小。');
 const ext=file.name.split('.').pop().toLowerCase();
 if(ext==='doc')throw Error('旧 DOC 请先另存为 DOCX 或 PDF。');
 if(ext==='pdf'){
 const doc=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
 return {name:file.name,count:doc.numPages,kind:'pdf',close:()=>doc.destroy(),read:async(start,end,preset='standard',visual=true)=>{
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>doc.numPages||end-start>=25)throw Error('每批需为有效的 1–25 页。');
 let text='',images=[],sources=[];const p=PRESETS[preset]||PRESETS.standard;
 for(let n=start;n<=end;n++){const page=await doc.getPage(n);try{const t=(await page.getTextContent()).items.map(i=>i.str).join(' ');text+='\n【'+file.name+' 第'+n+'页】\n'+t;sources.push({file:file.name,page:n});
 if(visual||!t.trim()){const v=page.getViewport({scale:1});const viewport=page.getViewport({scale:Math.min(3,p.edge/Math.max(v.width,v.height))});const c=document.createElement('canvas');c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height);try{await page.render({canvasContext:c.getContext('2d'),viewport}).promise;const blob=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',p.quality));if(!blob)throw Error('页面渲染失败');const f=new File([blob],file.name+'-第'+n+'页.jpg',{type:'image/jpeg'});f.source={file:file.name,page:n};images.push(f);}finally{c.width=c.height=0;}}
 }finally{page.cleanup();}}
 if(text.length>100000)throw Error('当前批次文字超过 10 万字，请减少每批页数。');return {text,images,sources};}};
 }
 let raw='';if(ext==='docx'){raw=(await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()})).value;}
 else if(['txt','md','markdown','csv','json','html','htm','log','xml'].includes(ext)){raw=await file.text();if(['html','htm'].includes(ext)){const d=new DOMParser().parseFromString(raw,'text/html');d.querySelectorAll('script,style').forEach(x=>x.remove());raw=d.body.textContent||'';}}
 else throw Error('不支持的格式，请转换为 PDF、DOCX 或文本。');
 if(!raw.trim())throw Error('未提取到文字，请转为 PDF 保留图像。');
 const chunks=[];for(let pos=0;pos<raw.length;pos+=12000)chunks.push(raw.slice(pos,pos+12000));
 return {name:file.name,kind:'text',count:chunks.length,close:async()=>{},read:async(start,end)=>({text:chunks.slice(start-1,end).map((x,i)=>'【'+file.name+' 文本段'+(start+i)+'】\n'+x).join('\n'),images:[],sources:Array.from({length:end-start+1},(_,i)=>({file:file.name,section:start+i}))})};
}
async function parse(file){const doc=await open(file);try{if(doc.count>24)throw Error('请使用文档任务队列分批加载。');return await doc.read(1,doc.count);}finally{await doc.close();}}
window.CardFlowFiles={open,parse,PRESETS,MAX_TEXT:100000};if(window.pdfjsLib)pdfjsLib.GlobalWorkerOptions.workerSrc='vendor/pdf.worker.min.js';
})();
