package com.kaddakaman.walker;

import android.Manifest;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * Counts steps with the phone's hardware step counter. Unlike the accelerometer
 * in the WebView, it keeps counting while the screen is off.
 *
 * Also exposes the "activity" (step counter) and "notifications" (tracking
 * notification) runtime permissions so the app can ask for them up front.
 */
@CapacitorPlugin(
    name = "WalkerSensors",
    permissions = {
        @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class WalkerSensorsPlugin extends Plugin implements SensorEventListener {

    private SensorManager sensorManager;
    private Sensor stepSensor;
    private boolean running = false;
    private float baseline = -1f; // sensor total when the walk started
    private float latest = -1f;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        stepSensor = sensorManager == null ? null : sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
    }

    @PluginMethod
    public void startSteps(PluginCall call) {
        JSObject ret = new JSObject();
        if (stepSensor == null) {
            ret.put("available", false);
            ret.put("reason", "no_sensor");
            call.resolve(ret);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && getPermissionState("activity") != PermissionState.GRANTED) {
            ret.put("available", false);
            ret.put("reason", "permission");
            call.resolve(ret);
            return;
        }
        baseline = -1f;
        latest = -1f;
        if (!running) {
            // Allow the sensor to batch events for up to 10 s while the screen is off.
            sensorManager.registerListener(this, stepSensor, SensorManager.SENSOR_DELAY_NORMAL, 10_000_000);
            running = true;
        }
        ret.put("available", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getSteps(PluginCall call) {
        if (running) sensorManager.flush(this);
        JSObject ret = new JSObject();
        ret.put("steps", currentSteps());
        call.resolve(ret);
    }

    @PluginMethod
    public void stopSteps(PluginCall call) {
        if (running) sensorManager.flush(this);
        int steps = currentSteps();
        stop();
        JSObject ret = new JSObject();
        ret.put("steps", steps);
        call.resolve(ret);
    }

    private int currentSteps() {
        if (baseline < 0 || latest < 0) return 0;
        return Math.max(0, Math.round(latest - baseline));
    }

    private void stop() {
        if (running && sensorManager != null) sensorManager.unregisterListener(this);
        running = false;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        latest = event.values[0];
        if (baseline < 0) baseline = latest;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected void handleOnDestroy() {
        stop();
    }
}
