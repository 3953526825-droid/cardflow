package cn.cardflow.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * CardFlow 离线版：页面资源全在 APK 里（assets/），不连任何服务器。
 *   - 用 WebViewAssetLoader 把 assets 挂到 https://appassets.androidplatform.net/，
 *     这样页面里的 /cardflow.css 这类「根路径」能正常解析，localStorage / Cookie 也能持久化；
 *   - window.CardFlowNative 提供直连 AI、生成 .apkg、系统语音、直写 AnkiDroid 卡片、另存为（NativeBridge）。
 *     （以前的 CardFlowAnki.saveApkg「交给 AnkiDroid 打开」已删：真机反馈不要自动跳转，.apkg 一律存成文件。）
 *   - onShowFileChooser：WebView 默认**不处理** <input type="file">，不接管的话「选择文件 / 拍照 / 点虚线框选图」
 *     点了完全没有反应（桌面浏览器自带文件选择器，所以只有手机上会暴露）。拍照与相册都从这里走。
 *
 * 一键导入（直写 AnkiDroid）需要 com.ichi2.anki.permission.READ_WRITE_DATABASE：
 * 启动时申请一次，用户拒绝后仍可重试（网页得到「不能直写」的自检结果时会让用户再点一次）。
 */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int REQUEST_ANKI_PERMISSION = 1001;
    private static final int REQUEST_FILE_CHOOSER = 1002;
    private static final int REQUEST_SAVE_AS = 1003;
    private WebView webView;
    private NativeBridge nativeBridge;
    private String pendingPermissionId = null;
    // <input type="file"> 的回调：必须原样回传（包括取消时回 null），否则这个 input 以后再也点不动
    private ValueCallback<Uri[]> fileChooserCallback = null;
    // 拍照写到这里（content:// 交给相机 App），从相机回来时用它当选中结果
    private Uri cameraOutputUri = null;
    // 「另存为」（SAF）的待写数据：用户在系统对话框里选好位置回来后落盘
    private String pendingSaveId = null;
    private byte[] pendingSaveBytes = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // 自签证书 / http 的 AI 接口都要能用
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptCookie(true);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        // 没有这一段，页面里的 <input type="file"> 点击完全没有反应（手机上「选择文件 / 拍照 / 点虚线框」全废）
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                cameraOutputUri = null;
                try {
                    startActivityForResult(buildFileChooserIntent(params), REQUEST_FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this, "打开文件选择器失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        nativeBridge = new NativeBridge(this);
        webView.addJavascriptInterface(nativeBridge, "CardFlowNative");
        webView.loadUrl(ORIGIN + "/index.html");
        // 启动就申请一次「读写 AnkiDroid 数据库」权限，用户允许后「导入 Anki」就能一键直写
        requestAnkiPermission(null);
    }

    /**
     * 按 <input> 的 accept / capture 拼出选择器：
     *   - capture="environment" + image/*（拍照按钮与虚线框都走它）→ 系统相机 + 相册二选一
     *   - accept 里带扩展名（.pdf/.docx…）时只能退化成 *\/*，否则文件选择器会把 PDF 藏起来
     */
    private Intent buildFileChooserIntent(WebChromeClient.FileChooserParams params) {
        boolean wantsImage = false;
        boolean hasExtension = false;
        List<String> mimes = new ArrayList<>();
        String[] accept = params.getAcceptTypes();
        if (accept != null) {
            for (String item : accept) {
                if (item == null || item.isEmpty()) continue;
                if (item.contains("/")) {
                    mimes.add(item);
                    if (item.startsWith("image/")) wantsImage = true;
                } else {
                    hasExtension = true;
                }
            }
        }
        if (params.isCaptureEnabled() && wantsImage) {
            Intent camera = buildCameraIntent();
            if (camera != null) {
                Intent gallery = new Intent(Intent.ACTION_GET_CONTENT);
                gallery.addCategory(Intent.CATEGORY_OPENABLE);
                gallery.setType("image/*");
                Intent chooser = Intent.createChooser(gallery, "拍照或从相册选择");
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { camera });
                return chooser;
            }
        }
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        if (!hasExtension && mimes.size() == 1) {
            pick.setType(mimes.get(0));
        } else {
            pick.setType("*/*");
            if (!hasExtension && mimes.size() > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
        }
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        return Intent.createChooser(pick, "选择文件");
    }

    /** 系统相机：拍完写进 cache/media/，再以 content:// 交回网页（FileProvider 已在 manifest 里声明） */
    private Intent buildCameraIntent() {
        try {
            Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            if (capture.resolveActivity(getPackageManager()) == null) return null;
            File dir = new File(getCacheDir(), "media");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File target = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
            cameraOutputUri = FileProvider.getUriForFile(this, "cn.cardflow.app.files", target);
            capture.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
            capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return capture;
        } catch (Exception error) {
            cameraOutputUri = null;
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_SAVE_AS) {
            finishSaveAs(resultCode, data);
            return;
        }
        if (requestCode != REQUEST_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == Activity.RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int index = 0; index < count; index++) result[index] = data.getClipData().getItemAt(index).getUri();
            } else if (data != null && data.getData() != null) {
                result = new Uri[] { data.getData() };
            } else if (cameraOutputUri != null) {
                result = new Uri[] { cameraOutputUri };
            }
        }
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(result);
            fileChooserCallback = null;
        }
        cameraOutputUri = null;
    }

    /** 让 NativeBridge 能在授权结果回来后把自检结果回给网页 */
    void setNativeBridge(NativeBridge bridge) {
        this.nativeBridge = bridge;
    }

    /* ===== 另存为（SAF）：备份 / 诊断包 / .apkg 让用户自己选保存位置 =====
       以前固定写进 Android/data/cn.cardflow.app/files/Download，真机反馈「在文件管理器里根本找不到」。
       ACTION_CREATE_DOCUMENT 与上面的文件选择器是同一套基建：结果在 onActivityResult 里落盘。 */
    /** 拉起系统「另存为」对话框；bytes 是要写的完整内容（网页侧已转好 base64）。
     *  NativeBridge 的桥方法在后台线程里调进来，弹对话框必须回 UI 线程。 */
    void launchSaveAs(String id, String name, String mime, byte[] bytes) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null || mime.trim().isEmpty() ? "application/octet-stream" : mime);
        intent.putExtra(Intent.EXTRA_TITLE, name == null || name.trim().isEmpty() ? "cardflow.bin" : name.trim());
        runOnUiThread(() -> {
            pendingSaveId = id;
            pendingSaveBytes = bytes;
            try {
                startActivityForResult(intent, REQUEST_SAVE_AS);
            } catch (Exception error) {
                pendingSaveId = null;
                pendingSaveBytes = null;
                Toast.makeText(this, "打不开系统保存对话框：" + error.getMessage(), Toast.LENGTH_LONG).show();
                replyToWeb(id, "{\"ok\":false,\"error\":\"打不开系统保存对话框\"}");
            }
        });
    }

    /** 用户选好位置（或取消）回来：写文件、Toast 结果、把结果回给网页。 */
    private void finishSaveAs(int resultCode, Intent data) {
        String id = pendingSaveId;
        byte[] bytes = pendingSaveBytes;
        pendingSaveId = null;
        pendingSaveBytes = null;
        if (id == null) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            Toast.makeText(this, "已取消，没有保存。", Toast.LENGTH_SHORT).show();
            runOnUiThread(() -> replyToWeb(id, "{\"ok\":false,\"error\":\"已取消\"}"));
            return;
        }
        Uri target = data.getData();
        // 写盘放后台线程（几十 MB 的备份包不能冻住 UI）；Toast 与回调都要回 UI 线程
        Thread writer = new Thread(() -> {
            String shown = target.getLastPathSegment();
            JSONObject result = new JSONObject();
            String toastText;
            try {
                try (java.io.OutputStream out = getContentResolver().openOutputStream(target)) {
                    if (out == null) throw new Exception("所选位置不可写。");
                    out.write(bytes);
                }
                // SAF 的 URI 不是真实文件路径，取「显示名」告诉用户存成了什么
                try (android.database.Cursor cursor = getContentResolver().query(target, null, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int col = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        if (col >= 0 && cursor.getString(col) != null) shown = cursor.getString(col);
                    }
                }
                toastText = "已保存：" + shown;
                result.put("ok", true);
                result.put("path", shown);
            } catch (Exception error) {
                toastText = "保存失败：" + error.getMessage();
                try {
                    result.put("ok", false);
                    result.put("error", String.valueOf(error.getMessage()));
                } catch (Exception ignored) { /* JSONObject 不会抛 */ }
            }
            String finalToast = toastText;
            JSONObject payload = result;
            runOnUiThread(() -> {
                Toast.makeText(this, finalToast, Toast.LENGTH_LONG).show();
                replyToWeb(id, payload.toString());
            });
        });
        writer.start();
    }

    /** 申请「读写 AnkiDroid 数据库」权限；给了 callbackId 就在结果出来后回调一次自检 */
    void requestAnkiPermission(String callbackId) {
        pendingPermissionId = callbackId;
        if (checkSelfPermission(AnkiDroidApi.PERMISSION) == PackageManager.PERMISSION_GRANTED) {
            finishAnkiPermission();
            return;
        }
        requestPermissions(new String[] { AnkiDroidApi.PERMISSION }, REQUEST_ANKI_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_ANKI_PERMISSION) finishAnkiPermission();
    }

    private void finishAnkiPermission() {
        String id = pendingPermissionId;
        pendingPermissionId = null;
        if (id == null || nativeBridge == null) return;
        nativeBridge.replyProbe(id);
    }

    /** 原生桥干完活把结果交回网页（NativeBridge 会在 UI 线程调用） */
    void replyToWeb(String id, String json) {
        if (webView == null) return;
        String script = "window.CardFlowNativeOnResponse(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")";
        webView.evaluateJavascript(script, null);
    }

    /** 后台线程里弹提示 */
    void toast(String message) {
        webView.post(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
