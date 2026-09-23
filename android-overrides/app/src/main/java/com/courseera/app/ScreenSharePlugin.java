package com.courseera.app;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.media.AudioManager;
import android.Manifest;

import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.PluginMethod;
import androidx.activity.result.ActivityResult;

@CapacitorPlugin(
        name = "ScreenShare",
        permissions = {
                @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
                @Permission(alias = "microphone", strings = {
                        Manifest.permission.RECORD_AUDIO,
                        Manifest.permission.MODIFY_AUDIO_SETTINGS
                })
        }
)
public class ScreenSharePlugin extends Plugin {
    private static final String SERVICE_ACTION_STOP = "com.courseera.app.STOP_SCREEN_SHARE";

    @PluginMethod
    public void configureAudio(PluginCall call) {
        try {
            AudioManager audio = (AudioManager) getContext().getSystemService(Activity.AUDIO_SERVICE);
            if (audio != null) {
                audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audio.setMicrophoneMute(false);
                if (android.os.Build.VERSION.SDK_INT >= 31) {
                    android.media.AudioDeviceInfo speaker = null;
                    for (android.media.AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                        if (d.getType() == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                            speaker = d;
                            break;
                        }
                    }
                    if (speaker != null) audio.setCommunicationDevice(speaker);
                }
                audio.setSpeakerphoneOn(true);
            }
            call.resolve();
        } catch (Exception e) {
            call.resolve();
        }
    }

    @PluginMethod
    public void restoreAudio(PluginCall call) {
        try {
            AudioManager audio = (AudioManager) getContext().getSystemService(Activity.AUDIO_SERVICE);
            if (audio != null) {
                if (android.os.Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice();
                audio.setSpeakerphoneOn(false);
                audio.setMode(AudioManager.MODE_NORMAL);
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String wsUrl = call.getString("wsUrl", "");
        if (wsUrl == null || wsUrl.trim().isEmpty()) {
            call.reject("Screen-share WebSocket URL is missing");
            return;
        }

        MediaProjectionManager manager =
                (MediaProjectionManager) getContext().getSystemService(Activity.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            call.reject("Android screen capture is not available on this device");
            return;
        }

        call.getData().put("wsUrl", wsUrl);
        Intent intent = manager.createScreenCaptureIntent();
        startActivityForResult(call, intent, "screenCaptureResult");
    }

    @ActivityCallback
    private void screenCaptureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Screen sharing permission was cancelled");
            return;
        }

        String wsUrl = call.getString("wsUrl", "");
        Intent service = new Intent(getContext(), ScreenShareService.class);
        service.putExtra("resultCode", result.getResultCode());
        service.putExtra("resultData", result.getData());
        service.putExtra("wsUrl", wsUrl);

        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(service);
            } else {
                getContext().startService(service);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start native screen sharing: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent stop = new Intent(getContext(), ScreenShareService.class);
            stop.setAction(SERVICE_ACTION_STOP);
            getContext().startService(stop);
        } catch (Exception ignored) {}
        call.resolve();
    }
}
