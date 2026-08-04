package com.homebase.app;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // The @capacitor/app plugin (which normally wires the hardware Back button
    // into the WebView's history) is not installed, so without this the Android
    // Back button just minimises the app instead of navigating. We drive the
    // WebView's own session history — which includes the app's History API
    // entries (tabs + overlays) — so Back peels overlays, then tabs, and only
    // minimises the app once we're at the Home base entry with nothing to undo.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = (getBridge() != null) ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack(); // fires popstate → app closes the top overlay / returns Home
                } else {
                    moveTaskToBack(true); // at Home root: send to background like the Home button
                }
            }
        });
    }
}
