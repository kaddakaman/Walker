package com.kaddakaman.walker;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WalkerSensorsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
