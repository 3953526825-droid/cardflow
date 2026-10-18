'use strict';
/* Node 侧的汇总入口：src/server.js 只 require('./shared') 一次拿全。
   浏览器侧不用它（离线页按 render → parse → cards → prompt 顺序各写一个 <script>）。 */
module.exports = {
  ...require('./render'),
  ...require('./parse'),
  ...require('./cards'),
  ...require('./prompt'),
  ...require('./generate'),
  ...require('./media-note'),
  ...require('./webfetch'),
  ...require('./search'),
  ...require('./research')
};
