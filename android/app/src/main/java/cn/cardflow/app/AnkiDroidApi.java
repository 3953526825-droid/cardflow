package cn.cardflow.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 直写 AnkiDroid（一键导入，不需要打包 .apkg、不需要用户再去点导入）。
 *
 * 依据 AnkiDroid 官方的 FlashCardsContract（content://com.ichi2.anki.flashcards）：
 *   - 牌组：query decks（列 deck_id / deck_name）；缺的牌组用 insert decks（列 deck_name）新建
 *   - 笔记类型：query models（列 _id / name / type，type=0 普通、1 填空）；**接口只能查不能建**，
 *     所以直写用的是用户 AnkiDroid 里已有的类型（优先用之前 .apkg 导入过的那两个，其次 Basic/Cloze）
 *   - 笔记：insert notes?deckId=<id>（列 mid / flds（字段用 \u001f 分隔）/ tags / allow_empty）
 *   - 媒体：insert media（列 file_uri / preferred_name）——遮挡卡的图片、音频卡的语音都靠它进 collection.media
 *
 * 注意：需要权限 com.ichi2.anki.permission.READ_WRITE_DATABASE（清单里声明 + 运行时授权），
 * 并且 AnkiDroid 那边要允许 API 访问；任一条不满足都会抛异常，由上层回退到 .apkg 那条路。
 */
final class AnkiDroidApi {
    static final String PACKAGE = "com.ichi2.anki";
    static final String PERMISSION = "com.ichi2.anki.permission.READ_WRITE_DATABASE";
    private static final Uri AUTHORITY = Uri.parse("content://com.ichi2.anki.flashcards");
    private static final Uri NOTES = Uri.withAppendedPath(AUTHORITY, "notes");
    private static final Uri MODELS = Uri.withAppendedPath(AUTHORITY, "models");
    private static final Uri DECKS = Uri.withAppendedPath(AUTHORITY, "decks");
    private static final Uri MEDIA = Uri.withAppendedPath(AUTHORITY, "media");

    private static final String[] PREFERRED_BASIC = { "CardFlow Basic", "Basic", "基础", "基本" };
    private static final String[] PREFERRED_CLOZE = { "CardFlow Cloze", "Cloze", "填空" };

    private final Activity activity;

    AnkiDroidApi(Activity activity) {
        this.activity = activity;
    }

    /** 有没有「读写 AnkiDroid 数据库」权限（没有就不能直写） */
    boolean hasPermission() {
        return activity.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** 装了 AnkiDroid 吗（Android 11+ 要清单里的 <queries>，那几个我们声明了） */
    private boolean installed() {
        try {
            activity.getPackageManager().getPackageInfo(PACKAGE, 0);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    /** 直写前的自检：能不能写、有哪些牌组、有没有可用的笔记类型 */
    JSONObject probe() {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", true);
            if (!installed()) {
                out.put("canWrite", false);
                out.put("reason", "手机上没找到 AnkiDroid：要一键导入请先装 AnkiDroid");
                out.put("decks", new JSONArray());
                return out;
            }
            if (!hasPermission()) {
                out.put("canWrite", false);
                out.put("reason", "缺少「读写 AnkiDroid 数据库」权限：请在弹出的授权提示里允许（若已拒绝，去系统设置里给 CardFlow 打开这个权限）");
                out.put("decks", new JSONArray());
                return out;
            }
            out.put("decks", new JSONArray(deckNames()));
            List<JSONObject> models = models();
            out.put("canWrite", pick(models, PREFERRED_BASIC, 0) != null);
            if (pick(models, PREFERRED_BASIC, 0) == null) out.put("reason", "AnkiDroid 里没有可用的普通笔记类型");
            else if (pick(models, PREFERRED_CLOZE, 1) == null) out.put("reason", "AnkiDroid 里没有可用的填空笔记类型（填空卡会改用 .apkg 导入）");
        } catch (Exception error) {
            return error(error);
        }
        return out;
    }

    /** AnkiDroid 里的牌组名 */
    List<String> deckNames() {
        List<String> names = new ArrayList<>();
        ContentResolver resolver = activity.getContentResolver();
        try (Cursor cursor = resolver.query(DECKS, null, null, null, null)) {
            if (cursor == null) return names;
            int column = cursor.getColumnIndex("deck_name");
            while (cursor.moveToNext()) {
                String name = column < 0 ? null : cursor.getString(column);
                if (name != null && !name.trim().isEmpty()) names.add(name);
            }
        } catch (Exception ignored) {
            // 查询失败（AnkiDroid 没配好/拒绝访问）就当没有牌组，由上层回退 .apkg
        }
        return names;
    }

    /** 笔记类型：每行 {id, name, type} */
    private List<JSONObject> models() {
        List<JSONObject> list = new ArrayList<>();
        ContentResolver resolver = activity.getContentResolver();
        try (Cursor cursor = resolver.query(MODELS, null, null, null, null)) {
            if (cursor == null) return list;
            int idAt = cursor.getColumnIndex("_id");
            int nameAt = cursor.getColumnIndex("name");
            int typeAt = cursor.getColumnIndex("type");
            while (cursor.moveToNext()) {
                JSONObject model = new JSONObject();
                model.put("id", idAt < 0 ? 0 : cursor.getLong(idAt));
                model.put("name", nameAt < 0 ? "" : cursor.getString(nameAt));
                model.put("type", typeAt < 0 ? 0 : cursor.getInt(typeAt));
                list.add(model);
            }
        } catch (Exception ignored) {
            // 同上：失败就当没有类型可用
        }
        return list;
    }

    /** 优先按名字挑（CardFlow 自己的类型 → Basic/Cloze → 第一个符合 kind 的），都没有就返回 null */
    private JSONObject pick(List<JSONObject> models, String[] preferred, int kind) {
        for (String name : preferred) {
            for (JSONObject model : models) {
                if (name.equals(model.optString("name")) && model.optInt("type") == kind) return model;
            }
        }
        for (JSONObject model : models) {
            if (model.optInt("type") == kind) return model;
        }
        return null;
    }

    /**
     * 上传媒体到 AnkiDroid 的 collection.media。
     * 输入 files: [{base64, preferredName}]；输出 files: [{preferredName, name}]（name 是 AnkiDroid 实际用的文件名）
     */
    JSONObject uploadMedia(JSONArray files) {
        JSONObject out = new JSONObject();
        JSONArray uploaded = new JSONArray();
        try {
            File dir = new File(activity.getCacheDir(), "media");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建临时目录");
            for (int i = 0; i < (files == null ? 0 : files.length()); i++) {
                JSONObject item = files.getJSONObject(i);
                String preferred = item.optString("preferredName", "");
                if (preferred.isEmpty()) continue;
                File source = new File(dir, "upload-" + System.nanoTime() + "-" + preferred);
                try (FileOutputStream stream = new FileOutputStream(source)) {
                    stream.write(Base64.decode(item.optString("base64", ""), Base64.DEFAULT));
                }
                Uri sourceUri = FileProvider.getUriForFile(activity, "cn.cardflow.app.files", source);
                activity.grantUriPermission(PACKAGE, sourceUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                ContentValues values = new ContentValues();
                values.put("file_uri", sourceUri.toString());
                values.put("preferred_name", preferred);
                Uri inserted = activity.getContentResolver().insert(MEDIA, values);
                if (inserted == null) throw new Exception("AnkiDroid 没有接受这个媒体文件（" + preferred + "）");
                String actual = inserted.getLastPathSegment();
                if (actual == null || actual.isEmpty()) actual = preferred;
                // 个别版本返回的名字不带扩展名，补上（字段 HTML 里引用的就是这个名字）
                if (!actual.contains(".") && preferred.contains(".")) actual += preferred.substring(preferred.lastIndexOf('.'));
                JSONObject record = new JSONObject();
                record.put("preferredName", preferred);
                record.put("name", actual);
                uploaded.put(record);
                if (!source.delete()) { /* 缓存目录留一份也无妨 */ }
            }
            out.put("ok", true);
            out.put("files", uploaded);
        } catch (Exception error) {
            return error(error);
        }
        return out;
    }

    /**
     * 写卡片。输入 {deck, notes:[{model:'Basic'|'Cloze', fields:[a,b], tags:[]}]}
     * 牌组不存在就先建（AnkiDroid 会顺带补上「父::子」的中间层）。
     */
    JSONObject addNotes(String deckName, JSONArray notes, boolean anyCloze) {
        JSONObject out = new JSONObject();
        int added = 0;
        JSONArray errors = new JSONArray();
        try {
            if (notes == null || notes.length() == 0) throw new Exception("没有要写入的卡片。");
            List<JSONObject> models = models();
            JSONObject basic = pick(models, PREFERRED_BASIC, 0);
            JSONObject cloze = pick(models, PREFERRED_CLOZE, 1);
            if (basic == null) throw new Exception("AnkiDroid 里没有可用的普通笔记类型");
            if (anyCloze && cloze == null) throw new Exception("AnkiDroid 里没有可用的填空笔记类型");
            long deckId = deckIdOf(String.valueOf(deckName == null ? "" : deckName).trim());
            ContentResolver resolver = activity.getContentResolver();
            ContentValues[] rows = new ContentValues[notes.length()];
            for (int i = 0; i < notes.length(); i++) {
                JSONObject note = notes.getJSONObject(i);
                boolean isCloze = "Cloze".equals(note.optString("model"));
                long mid = (isCloze ? cloze : basic).optLong("id");
                JSONArray fields = note.optJSONArray("fields");
                List<String> values = new ArrayList<>();
                if (fields != null) for (int f = 0; f < fields.length(); f++) values.add(fields.optString(f, ""));
                ContentValues row = new ContentValues();
                row.put("mid", mid);
                row.put("flds", String.join("\u001f", values));
                row.put("tags", String.join(" ", stringList(note.optJSONArray("tags"))));
                row.put("allow_empty", true);
                rows[i] = row;
            }
            // 牌组只能靠 bulkInsert 指定：FlashCardsContract 里 deckId 这个查询参数写着
            // 「Used only by bulkInsert()」—— 单个 insert 不管带没带，卡片都会落到默认牌组
            // （真机表现：牌组选得好好的，卡片全进了 Default）。所以整组一次性 bulkInsert。
            // 写不进去就如实抛错，让网页回退到 .apkg（apkg 里带着牌组名，串不了位置）。
            Uri target = NOTES.buildUpon().appendQueryParameter("deckId", String.valueOf(deckId)).build();
            int inserted = resolver.bulkInsert(target, rows);
            if (inserted <= 0) throw new Exception("AnkiDroid 没有接受任何卡片");
            if (inserted < rows.length) errors.put((rows.length - inserted) + " 张没能写入");
            added += inserted;
            out.put("ok", true);
            out.put("added", added);
            out.put("errors", errors);
        } catch (Exception error) {
            JSONObject failure = error(error);
            try {
                failure.put("added", added);
                failure.put("errors", errors);
            } catch (Exception ignored) { /* JSONObject 不会抛 */ }
            return failure;
        }
        return out;
    }

    /** 牌组名 → 牌组 id；不存在就新建（新建失败再查一次，免得并发/重名把导入卡死） */
    private long deckIdOf(String deckName) throws Exception {
        String name = deckName.isEmpty() ? "Default" : deckName;
        Long existing = findDeck(name);
        if (existing != null) return existing;
        ContentValues values = new ContentValues();
        values.put("deck_name", name);
        try {
            activity.getContentResolver().insert(DECKS, values);
        } catch (Exception ignored) {
            // AnkiDroid 对已存在的名字会抛异常：下面再查一次就拿到了
        }
        Long created = findDeck(name);
        if (created == null) throw new Exception("在 AnkiDroid 里建不了牌组：" + name);
        return created;
    }

    private Long findDeck(String name) {
        ContentResolver resolver = activity.getContentResolver();
        try (Cursor cursor = resolver.query(DECKS, null, null, null, null)) {
            if (cursor == null) return null;
            int idAt = cursor.getColumnIndex("deck_id");
            int nameAt = cursor.getColumnIndex("deck_name");
            // deck_name 可能是「父::子」的全名，这里按全名精确匹配
            Map<String, Long> byName = new LinkedHashMap<>();
            while (cursor.moveToNext()) {
                if (idAt < 0 || nameAt < 0) break;
                byName.put(cursor.getString(nameAt), cursor.getLong(idAt));
            }
            return byName.get(name);
        } catch (Exception error) {
            return null;
        }
    }

    private static List<String> stringList(JSONArray array) {
        List<String> list = new ArrayList<>();
        if (array == null) return list;
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "").trim();
            if (!value.isEmpty()) list.add(value);
        }
        return list;
    }

    private static JSONObject error(Exception error) {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", false);
            out.put("error", String.valueOf(error.getMessage() == null ? error : error.getMessage()));
        } catch (Exception ignored) { /* JSONObject 不会抛 */ }
        return out;
    }
}
