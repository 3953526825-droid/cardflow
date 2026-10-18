'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const DIR = process.env.ANKI_PACKS_DIR || path.join(ROOT, 'packs');
const { CURRENT_SCHEMA, MIGRATIONS, migrate, validate, materialize } = require('./shared/pack-schema');
/* ===== 学科包 schema 版本与升级路径 =====
   当前支持到 CURRENT_SCHEMA。加新版本时在 MIGRATIONS 里补一条「旧版本 → 新版本」的函数即可，
   已导入的老包会在读取/保存时自动升上来（不用让用户重新导入）。 */
function fileFor(id) { return path.join(DIR, id + '.json'); }
function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(n => /^[a-z][a-z0-9-]{1,31}\.json$/.test(n)).map(n => validate(JSON.parse(fs.readFileSync(path.join(DIR,n),'utf8'))));
}
function save(input, occupied) {
  const x = validate(input);
  if (occupied.has(x.id)) throw Error('学科包 ID 已存在，请换一个 id。');
  fs.mkdirSync(DIR,{recursive:true});
  const fd=fs.openSync(fileFor(x.id),'wx');
  try { fs.writeFileSync(fd, JSON.stringify(x,null,2)+'\n'); } finally { fs.closeSync(fd); }
}
function update(input) {
  const x = validate(input);
  const file = fileFor(x.id);
  if (!fs.existsSync(file)) throw Error('学科包不存在或不可编辑。');
  const backups = process.env.ANKI_PACKS_BACKUP_DIR || path.join(ROOT, 'backups', 'packs');
  fs.mkdirSync(backups, { recursive: true });
  fs.copyFileSync(file, path.join(backups, `${x.id}-${Date.now()}.bak`), fs.constants.COPYFILE_EXCL);
  const tmp = path.join(DIR, `${x.id}.${process.pid}.${Date.now()}.tmp`);
  try { fs.writeFileSync(tmp, JSON.stringify(x,null,2)+'\n', { flag: 'wx' }); fs.renameSync(tmp,file); }
  catch (error) { try { fs.unlinkSync(tmp); } catch (_) {} throw error; }
}
function remove(id) { if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw Error('无效的学科包 ID。'); fs.unlinkSync(fileFor(id)); }
module.exports={DIR,validate,migrate,CURRENT_SCHEMA,list,save,update,remove,materialize,fileFor};
