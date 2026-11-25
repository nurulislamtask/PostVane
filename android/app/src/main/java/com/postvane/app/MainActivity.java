package com.postvane.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/** PostVane for Android: a companion that opens the dashboard of the PostVane running on your own computer. */
public class MainActivity extends Activity {
    private static final int PICK_FILES = 7;
    private WebView web;
    private ValueCallback<Uri[]> chooser;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "video/*"});
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(i, PICK_FILES);
                return true;
            }
        });
        String url = prefs().getString("server", "");
        if (url.isEmpty()) askServer(); else web.loadUrl(url);
    }

    private SharedPreferences prefs() { return getSharedPreferences("postvane", MODE_PRIVATE); }

    private void askServer() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("http://192.168.1.10:4317");
        input.setText(prefs().getString("server", ""));
        new AlertDialog.Builder(this)
            .setTitle("PostVane server address")
            .setMessage("The address of the computer running PostVane. Use a private network such as Tailscale; the dashboard has no login.")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Connect", (d, w) -> {
                String u = input.getText().toString().trim();
                if (!u.startsWith("http")) u = "http://" + u;
                prefs().edit().putString("server", u).apply();
                web.loadUrl(u);
            })
            .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu m) { m.add(0, 1, 0, "Server address"); m.add(0, 2, 1, "Reload"); return true; }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) askServer(); else if (item.getItemId() == 2) web.reload();
        return true;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK_FILES && chooser != null) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[] {data.getData()};
                }
            }
            chooser.onReceiveValue(out);
            chooser = null;
        }
    }

    @Override
    public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
