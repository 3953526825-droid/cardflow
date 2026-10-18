package cn.cardflow.app;

import android.os.Bundle;
import android.os.Environment;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 网页侧的离线能力（window.CardFlowNative），所有方法都是「异步 + 回调」：
 *   网页调用 nativeCall('方法名', id, 参数) → 这里开线程干活 → 干完回调 window.CardFlowNativeOnResponse(id, 结果)。
 * 为什么要异步：AI 请求、生成 .apkg、语音合成都可能几十秒，同步调用会把网页线程冻住。
 *
 * 方法：
 *   httpRequest(id, {url,method,headers,body})  → {status, body}     绕开浏览器 CORS 直连 AI 接口
 *   buildApkg(id, {decks,media})               → {base64}            用系统 SQLite 生成 .apkg
 *   decks(id, {})                              → {decks,canWrite}    读 AnkiDroid 牌组 + 能不能直写
 *   uploadMedia(id, {files})                   → {files:[{preferredName,name}]}  媒体进 collection.media
 *   addNotes(id, {deck,notes,anyCloze})        → {added,errors}      直写卡片（一键导入）
 *   tts(id, {text})                            → {dataUrl}           系统语音合成（音频卡自动配音）
 *   saveFile(name, base64)                     不回调                  把网页里 blob 下载的文件写进应用下载目录
 *   saveFileAs(id, {name,mime,data})           → {ok,path|error}     系统「另存为」（SAF）：用户自己选保存位置
 */
public class NativeBridge {
    private final MainActivity activity;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final AnkiDroidApi anki;
    private TextToSpeech tts = null;
    private volatile CountDownLatch ttsLatch = null;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
        this.anki = new AnkiDroidApi(activity);
    }

    @JavascriptInterface
    public void httpRequest(String id, String payload) {
        pool.submit(() -> reply(id, http(payload)));
    }

    @JavascriptInterface
    public void buildApkg(String id, String payload) {
        pool.submit(() -> reply(id, apkg(payload)));
    }

    @JavascriptInterface
    public void decks(String id, String payload) {
        pool.submit(() -> reply(id, anki.probe()));
    }

    @JavascriptInterface
    public void uploadMedia(String id, String payload) {
        pool.submit(() -> {
            try {
                reply(id, anki.uploadMedia(new JSONObject(payload).optJSONArray("files")));
            } catch (Exception error) {
                reply(id, error(error));
            }
        });
    }

    @JavascriptInterface
    public void addNotes(String id, String payload) {
        pool.submit(() -> {
            try {
                JSONObject request = new JSONObject(payload);
                reply(id, anki.addNotes(request.optString("deck", ""), request.optJSONArray("notes"), request.optBoolean("anyCloze", true)));
            } catch (Exception error) {
                reply(id, error(error));
            }
        });
    }

    /** 网页发现「不能直写」时可以让用户再授权一次；结果会以自检结果（decks）回调回去 */
    @JavascriptInterface
    public void requestAnkiPermission(String id, String payload) {
        activity.requestAnkiPermission(id);
    }

    /** 授权结果回来后把最新的自检结果回给网页 */
    void replyProbe(String id) {
        pool.submit(() -> reply(id, anki.probe()));
    }

    @JavascriptInterface
    public void tts(String id, String payload) {
        pool.submit(() -> reply(id, speak(payload)));
    }

    /**
     * 网页里用 blob URL + <a download> 的下载（备份 / 诊断包 / .apkg 的普通下载退路）在 WebView 里是不响的：
     * WebView 没有 DownloadListener 时既不下载也不提示。离线页会拦住这种点击，把字节改成 base64 交到这里落盘。
     * 不回调（网页那边拿不到结果也无所谓），成功与否用 Toast 告诉用户。
     */
    @JavascriptInterface
    public void saveFile(String name, String base64) {
        pool.submit(() -> {
            try {
                String safe = (name == null || name.trim().isEmpty()) ? "cardflow.bin" : name.trim().replaceAll("[\\\\/:*?\"<>|]", "_");
                File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = activity.getFilesDir();
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("下载目录不可写。");
                File target = new File(dir, safe);
                try (FileOutputStream out = new FileOutputStream(target)) {
                    out.write(Base64.decode(base64, Base64.DEFAULT));
                }
                activity.toast("已保存：" + target.getName() + "（在手机的 Android/data/cn.cardflow.app/files/Download 下）");
            } catch (Exception error) {
                activity.toast("保存失败：" + error.getMessage());
            }
        });
    }

    /** 系统「另存为」（SAF，ACTION_CREATE_DOCUMENT）：备份 / 诊断包让用户自己选保存位置。
     *  与 saveFile 的区别：有回调（{ok, path|error}），用户取消时网页侧知道「没有保存」。 */
    @JavascriptInterface
    public void saveFileAs(String id, String payload) {
        try {
            JSONObject request = new JSONObject(payload);
            byte[] bytes = Base64.decode(request.optString("data", ""), Base64.DEFAULT);
            activity.launchSaveAs(id, request.optString("name", ""), request.optString("mime", ""), bytes);
        } catch (Exception error) {
            reply(id, error(error));
        }
    }

    private void reply(String id, JSONObject result) {
        // 回调必须回到 WebView 所在的线程
        activity.runOnUiThread(() -> activity.replyToWeb(id, result.toString()));
    }

    /* ===== 直连 AI 接口（浏览器里会被 CORS 拦住，这里用 HttpURLConnection 原样转发） ===== */
    private JSONObject http(String payload) {
        JSONObject out = new JSONObject();
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject(payload);
            String url = request.optString("url", "");
            if (url.isEmpty()) throw new Exception("请求地址为空。");
            byte[] body = request.optString("body", "").getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod(request.optString("method", "GET").toUpperCase(Locale.ROOT));
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(300000);
            connection.setInstanceFollowRedirects(true);
            JSONObject headers = request.optJSONObject("headers");
            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    connection.setRequestProperty(key, headers.optString(key, ""));
                }
            }
            if (body.length > 0) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream stream = connection.getOutputStream()) {
                    stream.write(body);
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : new String(readAll(stream), StandardCharsets.UTF_8);
            out.put("ok", true);
            out.put("status", status);
            out.put("body", text);
        } catch (Exception error) {
            out = error(error);
        } finally {
            if (connection != null) connection.disconnect();
        }
        return out;
    }

    /* ===== .apkg：交给 ApkgWriter ===== */
    private JSONObject apkg(String payload) {        try {
            JSONObject input = new JSONObject(payload);
            long started = System.currentTimeMillis();
            byte[] bytes = ApkgWriter.build(input, activity.getCacheDir());
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            out.put("bytes", bytes.length);
            out.put("ms", System.currentTimeMillis() - started);
            return out;
        } catch (Exception error) {
            return error(error);
        }
    }

    /* ===== 系统语音合成：写到缓存目录再读成 base64（Audio 卡自动配音） ===== */
    private JSONObject speak(String payload) {
        File target = null;
        try {
            JSONObject request = new JSONObject(payload);
            String text = request.optString("text", "").trim();
            if (text.isEmpty()) throw new Exception("没有要朗读的文本。");
            TextToSpeech engine = ensureTts();
            target = new File(activity.getCacheDir(), "cardflow-tts-" + System.nanoTime() + ".wav");
            CountDownLatch latch = new CountDownLatch(1);
            ttsLatch = latch;
            int queued = engine.synthesizeToFile(text, new Bundle(), target, "cardflow-" + System.nanoTime());
            if (queued != TextToSpeech.SUCCESS) throw new Exception("系统语音合成不可用。");
            latch.await(30, TimeUnit.SECONDS);
            if (!target.exists() || target.length() <= 44) throw new Exception("系统语音合成没有产出音频（可能没装中文语音）。");
            byte[] bytes = readAll(new FileInputStream(target));
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("dataUrl", "data:audio/wav;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            return out;
        } catch (Exception error) {
            return error(error);
        } finally {
            if (target != null && !target.delete()) { /* 缓存目录里删不掉也无所谓 */ }
        }
    }

    private TextToSpeech ensureTts() throws Exception {
        if (tts != null) return tts;
        CountDownLatch ready = new CountDownLatch(1);
        final int[] initStatus = { TextToSpeech.ERROR };
        TextToSpeech engine = new TextToSpeech(activity, status -> { initStatus[0] = status; ready.countDown(); });
        if (!ready.await(10, TimeUnit.SECONDS)) throw new Exception("系统语音引擎启动超时。");
        if (initStatus[0] != TextToSpeech.SUCCESS) {
            engine.shutdown();
            throw new Exception("系统里没有可用的语音引擎（到系统设置的「文字转语音」里装一个中文语音）。");
        }
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) { }
            @Override public void onDone(String utteranceId) { if (ttsLatch != null) ttsLatch.countDown(); }
            @Override public void onError(String utteranceId) { if (ttsLatch != null) ttsLatch.countDown(); }
            @Override public void onError(String utteranceId, int errorCode) { if (ttsLatch != null) ttsLatch.countDown(); }
        });
        int lang = engine.setLanguage(Locale.CHINA);
        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
            engine.shutdown();
            throw new Exception("系统语音引擎没有中文语音（到系统设置的「文字转语音」里下载中文语音包）。");
        }
        tts = engine;
        return tts;
    }

    private static byte[] readAll(InputStream input) throws Exception {
        try (InputStream stream = input) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int count;
            while ((count = stream.read(chunk)) > 0) out.write(chunk, 0, count);
            return out.toByteArray();
        }
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
