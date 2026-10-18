package cn.cardflow.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 在本机生成 .apkg（Anki 的导入包），不依赖桌面 Anki 与 AnkiConnect。
 *
 * 与桌面版的服务端实现（src/apkg.js）逐条对齐：同样是 schema 11 的 collection.anki2，
 * 同样的模型（CardFlow Basic / CardFlow Cloze，id 1699999900001/2）、同样的 guid 与 csum 算法、
 * 同样的牌组表结构；媒体文件按「media 映射 + 数字文件名」放进 zip。
 *
 * 输入 JSON（由网页侧 public/local-api.js 组装）：
 *   {"decks":[{"name":"父牌组::子牌组","notes":[{"model":"Basic|Cloze","fields":["",""],"tags":[""]}]}],
 *    "media":[{"filename":"cardflow-xxx.png","base64":"..."}]}
 * 输出：{"ok":true,"base64":"<zip 字节的 base64>","filename":"..."}；出错时 {"ok":false,"error":"..."}
 */
final class ApkgWriter {
    private static final long BASIC_ID = 1699999900001L;
    private static final long CLOZE_ID = 1699999900002L;

    private static final String SCHEMA_SQL = String.join("\n",
        "CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,",
        "  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,",
        "  models text not null, decks text not null, dconf text not null, tags text not null);",
        "CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,",
        "  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,",
        "  flags integer not null, data text not null);",
        "CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,",
        "  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,",
        "  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,",
        "  odue integer not null, odid integer not null, flags integer not null, data text not null);",
        "CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,",
        "  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);",
        "CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);",
        "CREATE INDEX ix_notes_usn ON notes (usn);",
        "CREATE INDEX ix_cards_usn ON cards (usn);",
        "CREATE INDEX ix_cards_nid ON cards (nid);",
        "CREATE INDEX ix_cards_sched ON cards (did, queue, due);",
        "CREATE INDEX ix_revlog_usn ON revlog (usn);",
        "CREATE INDEX ix_revlog_cid ON revlog (cid);",
        "CREATE INDEX ix_notes_csum ON notes (csum);");

    /* 卡片样式与 LaTeX 前言：与 src/apkg.js 里的字符串逐字一致 */
    private static final String LATEX_PRE =
        "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8,ucs,hyperref]{inputenc}\n"
        + "\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n";

    private static final String[] CARD_CSS_LINES = {
        ".card {",
        "  font-family: -apple-system, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif;",
        "  font-size: 20px;",
        "  line-height: 1.65;",
        "  text-align: left;",
        "  color: #203b56;",
        "  background: #f7fbfd;",
        "  padding: 14px 16px;",
        "}",
        ".card b, .card strong { color: #12395f; }",
        ".card img { max-width: 100%; height: auto; }",
        ".card audio { max-width: 100%; }",
        ".card small { color: #61778c; }",
        ".nightMode .card, .night_mode .card { color: #e6edf5; background: #16202b; }",
        ".nightMode .card b, .nightMode .card strong, .night_mode .card b, .night_mode .card strong { color: #cfe4ff; }",
        ".nightMode .card small, .night_mode .card small { color: #9db0c4; }"
    };

    private static final String DCONF_JSON = "{"
        + "\"1\":{\"id\":1,\"name\":\"Default\",\"replayq\":true,\"timer\":0,\"maxTaken\":60,\"autoplay\":true,\"mod\":0,"
        + "\"usn\":0,\"addToCur\":true,"
        + "\"new\":{\"delays\":[1,10],\"ints\":[1,4],\"initialFactor\":2500,\"separate\":true,\"order\":1,\"perDay\":20,\"bury\":false},"
        + "\"rev\":{\"perDay\":200,\"ease4\":1.3,\"ivlFct\":1,\"maxIvl\":36500,\"bury\":false,\"hardFactor\":1.2},"
        + "\"lapse\":{\"delays\":[10],\"mult\":0,\"minInt\":1,\"leechFails\":8,\"leechAction\":0},\"dyn\":false}}";

    private ApkgWriter() { }

    /** 纯文本：给 sfld / csum 用（去掉 HTML、媒体标记与 cloze 包裹）—— 与 src/apkg.js 的 plainText 一致 */
    static String plainText(String html) {
        String text = html == null ? "" : html;
        text = text.replaceAll("\\[sound:[^\\]]*\\]", "");
        text = text.replaceAll("<[^>]*>", "");
        text = text.replaceAll("\\{\\{c\\d+::(.*?)(?:::[^}]*)?\\}\\}", "$1");
        text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">");
        return text.replaceAll("\\s+", " ").trim();
    }

    /** Anki 的字段校验和：sha1 的前 4 字节按无符号整数（与 apkg.js 的 fieldChecksum 一致） */
    static long fieldChecksum(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
            return ((long) (digest[0] & 0xFF) << 24) | ((digest[1] & 0xFF) << 16) | ((digest[2] & 0xFF) << 8) | (digest[3] & 0xFF);
        } catch (Exception error) {
            return 0;
        }
    }

    /** 笔记 guid：sha256(模型id \u001f 字段) 的 base64 前 8 位（与 apkg.js 一致，Anki 靠它去重） */
    static String guid(long mid, String flds) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((mid + "\u001f" + flds).getBytes(StandardCharsets.UTF_8));
            String base64 = Base64.encodeToString(digest, Base64.NO_WRAP);
            return base64.length() > 8 ? base64.substring(0, 8) : base64;
        } catch (Exception error) {
            return "";
        }
    }

    private static JSONObject field(String name) throws Exception {
        JSONObject field = new JSONObject();
        field.put("name", name);
        field.put("ord", name.equals("Front") || name.equals("Text") ? 0 : 1);
        field.put("sticky", false);
        field.put("rtl", false);
        field.put("font", "Arial");
        field.put("size", 20);
        field.put("media", new JSONArray());
        return field;
    }

    private static JSONObject template(String name, String qfmt, String afmt) throws Exception {
        JSONObject template = new JSONObject();
        template.put("name", name);
        template.put("ord", 0);
        template.put("qfmt", qfmt);
        template.put("afmt", afmt);
        template.put("bqfmt", "");
        template.put("bafmt", "");
        template.put("did", JSONObject.NULL);
        template.put("bfont", "");
        template.put("bsize", 0);
        return template;
    }

    /** 两个模型的定义（CardFlow Basic / CardFlow Cloze），不会覆盖用户已有的模板 */
    private static JSONObject models(long nowSec, String css) throws Exception {
        JSONObject basic = new JSONObject();
        basic.put("id", BASIC_ID);
        basic.put("name", "CardFlow Basic");
        basic.put("type", 0);
        basic.put("mod", nowSec);
        basic.put("usn", -1);
        basic.put("sortf", 0);
        basic.put("did", JSONObject.NULL);
        basic.put("tmpls", new JSONArray().put(template("正面 → 背面", "{{Front}}", "{{Front}}<hr id=answer>{{Back}}")));
        basic.put("flds", new JSONArray().put(field("Front")).put(field("Back")));
        basic.put("css", css);
        basic.put("latexPre", LATEX_PRE);
        basic.put("latexPost", "\\end{document}");
        basic.put("latexsvg", false);
        basic.put("req", new JSONArray().put(new JSONArray().put(0).put("any").put(new JSONArray().put(0))));
        basic.put("tags", new JSONArray());
        basic.put("vers", new JSONArray());

        JSONObject cloze = new JSONObject();
        cloze.put("id", CLOZE_ID);
        cloze.put("name", "CardFlow Cloze");
        cloze.put("type", 1);
        cloze.put("mod", nowSec);
        cloze.put("usn", -1);
        cloze.put("sortf", 0);
        cloze.put("did", JSONObject.NULL);
        cloze.put("tmpls", new JSONArray().put(template("填空", "{{cloze:Text}}", "{{cloze:Text}}<br>{{Back Extra}}")));
        cloze.put("flds", new JSONArray().put(field("Text")).put(field("Back Extra")));
        cloze.put("css", css);
        cloze.put("latexPre", LATEX_PRE);
        cloze.put("latexPost", "\\end{document}");
        cloze.put("latexsvg", false);
        cloze.put("req", new JSONArray());
        cloze.put("tags", new JSONArray());
        cloze.put("vers", new JSONArray());

        JSONObject all = new JSONObject();
        all.put(String.valueOf(BASIC_ID), basic);
        all.put(String.valueOf(CLOZE_ID), cloze);
        return all;
    }

    /**
     * 生成 .apkg 字节。
     * @param input 见类注释的输入 JSON
     * @param workDir 用来放临时 collection.anki2（生成完自己删掉）
     */
    static byte[] build(JSONObject input, File workDir) throws Exception {
        JSONArray deckList = input.optJSONArray("decks");
        if (deckList == null || deckList.length() == 0) throw new Exception(".apkg 导出缺少牌组。");
        List<JSONObject> decks = new ArrayList<>();
        List<String> deckNames = new ArrayList<>();
        for (int i = 0; i < deckList.length(); i++) {
            JSONObject deck = deckList.optJSONObject(i);
            if (deck == null) continue;
            String name = deck.optString("name", "").trim();
            if (name.isEmpty() || deckNames.contains(name)) continue;
            decks.add(deck);
            deckNames.add(name);
        }
        if (decks.isEmpty()) throw new Exception(".apkg 导出缺少牌组。");

        long nowMs = System.currentTimeMillis();
        long nowSec = nowMs / 1000;
        String css = String.join("\n", CARD_CSS_LINES);

        /* 牌组表：父牌组 id=1，子牌组依次 2、3…（名字里的 :: 就是层级） */
        JSONObject deckTable = new JSONObject();
        for (int i = 0; i < decks.size(); i++) {
            int id = i + 1;
            JSONObject record = new JSONObject();
            record.put("id", id);
            record.put("name", deckNames.get(i));
            record.put("conf", 1);
            record.put("desc", "");
            record.put("dyn", 0);
            record.put("collapsed", false);
            record.put("extendNew", 10);
            record.put("extendRev", 50);
            record.put("newToday", new JSONArray().put(0).put(0));
            record.put("revToday", new JSONArray().put(0).put(0));
            record.put("lrnToday", new JSONArray().put(0).put(0));
            record.put("timeToday", new JSONArray().put(0).put(0));
            record.put("browserCollapsed", false);
            record.put("usn", 0);
            record.put("mod", nowSec);
            record.put("maxTaken", 0);
            record.put("closed", false);
            record.put("dyn2", false);
            deckTable.put(String.valueOf(id), record);
        }
        JSONObject colConf = new JSONObject();
        colConf.put("nextPos", 1);
        colConf.put("estTimes", true);
        colConf.put("activeDecks", new JSONArray().put(1));
        colConf.put("sortType", "noteFld");
        colConf.put("timeLim", 0);
        colConf.put("sortBackwards", false);
        colConf.put("addToCur", true);
        colConf.put("curDeck", 1);
        colConf.put("newBury", true);
        colConf.put("newSpread", 0);
        colConf.put("dueCounts", true);
        colConf.put("curModel", String.valueOf(BASIC_ID));
        colConf.put("collapseTime", 1200);

        File dbFile = new File(workDir, "collection.anki2");
        if (dbFile.exists() && !dbFile.delete()) throw new Exception("无法清理临时文件：" + dbFile.getName());
        byte[] collection;
        SQLiteDatabase db = null;
        try {
            db = SQLiteDatabase.openOrCreateDatabase(dbFile, null);
            // PRAGMA journal_mode = DELETE 会返回一行结果，execSQL 遇到有返回值的语句会抛
            // 「Queries can be performed using SQLiteDatabase query or rawQuery methods only」
            // ——真机上「下载 .apkg」失败就是这句。必须用 rawQuery 再关掉游标。
            Cursor journal = db.rawQuery("PRAGMA journal_mode = DELETE", null);
            try {
                if (journal != null) journal.moveToFirst();
            } finally {
                if (journal != null) journal.close();
            }
            for (String statement : SCHEMA_SQL.split(";")) {
                if (!statement.trim().isEmpty()) db.execSQL(statement);
            }
            ContentValues col = new ContentValues();
            col.put("id", 1);
            col.put("crt", nowSec);
            col.put("mod", nowMs);
            col.put("scm", nowMs);
            col.put("ver", 11);
            col.put("dty", 0);
            col.put("usn", 0);
            col.put("ls", 0);
            col.put("conf", colConf.toString());
            col.put("models", models(nowSec, css).toString());
            col.put("decks", deckTable.toString());
            col.put("dconf", DCONF_JSON);
            col.put("tags", "{}");
            db.insert("col", null, col);

            db.beginTransaction();
            try {
                long noteSeq = 0;
                int dueSeq = 0;
                for (int index = 0; index < decks.size(); index++) {
                    int deckId = index + 1;
                    JSONArray notes = decks.get(index).optJSONArray("notes");
                    if (notes == null) continue;
                    for (int n = 0; n < notes.length(); n++) {
                        JSONObject note = notes.optJSONObject(n);
                        if (note == null) continue;
                        boolean cloze = "Cloze".equals(note.optString("model", "Basic"));
                        long mid = cloze ? CLOZE_ID : BASIC_ID;
                        JSONArray rawFields = note.optJSONArray("fields");
                        List<String> fields = new ArrayList<>();
                        if (rawFields != null) for (int f = 0; f < rawFields.length(); f++) fields.add(rawFields.optString(f, ""));
                        String flds = String.join("\u001f", fields);
                        String sfld = plainText(fields.isEmpty() ? "" : fields.get(0));
                        long noteId = nowMs + (noteSeq++);

                        JSONArray rawTags = note.optJSONArray("tags");
                        StringBuilder tags = new StringBuilder();
                        if (rawTags != null) {
                            for (int t = 0; t < rawTags.length(); t++) {
                                String tag = rawTags.optString(t, "").trim();
                                if (tag.isEmpty()) continue;
                                if (tags.length() > 0) tags.append(' ');
                                tags.append(tag.replaceAll("\\s+", "_"));
                            }
                        }
                        ContentValues noteRow = new ContentValues();
                        noteRow.put("id", noteId);
                        noteRow.put("guid", guid(mid, flds));
                        noteRow.put("mid", mid);
                        noteRow.put("mod", nowMs);
                        noteRow.put("usn", -1);
                        noteRow.put("tags", tags.length() > 0 ? " " + tags + " " : "");
                        noteRow.put("flds", flds);
                        noteRow.put("sfld", sfld);
                        noteRow.put("csum", fieldChecksum(sfld));
                        noteRow.put("flags", 0);
                        noteRow.put("data", "");
                        db.insert("notes", null, noteRow);

                        ContentValues card = new ContentValues();
                        card.put("id", noteId);
                        card.put("nid", noteId);
                        card.put("did", deckId);
                        card.put("ord", 0);
                        card.put("mod", nowMs);
                        card.put("usn", -1);
                        card.put("type", 0);
                        card.put("queue", 0);
                        card.put("due", dueSeq++);
                        card.put("ivl", 0);
                        card.put("factor", 2500);
                        card.put("reps", 0);
                        card.put("lapses", 0);
                        card.put("left", 0);
                        card.put("odue", 0);
                        card.put("odid", 0);
                        card.put("flags", 0);
                        card.put("data", "");
                        db.insert("cards", null, card);
                    }
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        } finally {
            if (db != null) db.close();
        }
        collection = readAll(dbFile);
        if (!dbFile.delete()) { /* 删不掉也不影响结果，系统会清缓存目录 */ }

        /* 媒体：media 映射 + 以序号命名的文件，与 apkg.js 同一套约定 */
        JSONArray media = input.optJSONArray("media");
        JSONObject mediaMap = new JSONObject();
        List<byte[]> mediaFiles = new ArrayList<>();
        if (media != null) {
            for (int i = 0; i < media.length(); i++) {
                JSONObject item = media.optJSONObject(i);
                if (item == null) continue;
                String filename = item.optString("filename", "");
                String base64 = item.optString("base64", "");
                if (filename.isEmpty() || base64.isEmpty()) continue;
                mediaMap.put(String.valueOf(mediaFiles.size()), filename);
                mediaFiles.add(Base64.decode(base64, Base64.DEFAULT));
            }
        }

        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        ZipOutputStream zip = new ZipOutputStream(buffer);
        zip.putNextEntry(new ZipEntry("collection.anki2"));
        zip.write(collection);
        zip.closeEntry();
        if (!mediaFiles.isEmpty()) {
            zip.putNextEntry(new ZipEntry("media"));
            zip.write(mediaMap.toString().getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            for (int i = 0; i < mediaFiles.size(); i++) {
                zip.putNextEntry(new ZipEntry(String.valueOf(i)));
                zip.write(mediaFiles.get(i));
                zip.closeEntry();
            }
        }
        zip.close();
        return buffer.toByteArray();
    }

    private static byte[] readAll(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int count;
            while ((count = input.read(chunk)) > 0) out.write(chunk, 0, count);
            return out.toByteArray();
        }
    }
}
