'use strict';
/* 遮挡卡 / 音频卡的「媒体 + 笔记」：
   - media()：把 base64 的图片/音频交给 Anki（或 .apkg 收集器），返回文件名；
   - note()：生成一张笔记（字段 HTML 用 src/shared/media-note.js，与安卓壳离线页同一份排版）。
*/
const crypto=require('node:crypto');const core=require('../public/core');
const {mediaNote}=require('./shared/media-note');
async function media(data,anki){const m=/^data:((?:image|audio)\/[\w+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data||'');if(!m)throw Error('媒体格式无效');const bytes=Buffer.from(m[2],'base64');if(bytes.length>12*1024*1024)throw Error('单张卡媒体超过 12MB');const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/ogg':'ogg'})[m[1]];if(!ext)throw Error('媒体格式不支持');const filename='cardflow-'+crypto.createHash('sha256').update(bytes).digest('hex').slice(0,24)+'.'+ext;await anki('storeMediaFile',{filename,data:m[2]});return filename;}
async function note(card,deck,tags,anki,fields){const issue=core.issue(card);if(issue)throw Error(issue);const filename=await media(card.type==='audio'?card.audio:card.image,anki);const html=mediaNote(card,filename);return {deckName:deck,modelName:'Basic',fields:await fields('Basic',html.front,html.back,['Front','Back']),tags:card.tags||tags};}
module.exports={note,media};
