package com.courseera.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.annotation.Nullable;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.Response;
import okio.ByteString;

public class ScreenShareService extends Service {
    private static final String ACTION_STOP = "com.courseera.app.STOP_SCREEN_SHARE";
    private static final String CHANNEL_ID = "course_era_screen_share";
    private static final int NOTIFICATION_ID = 7312;

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private SurfaceHolder surfaceHolder;
    private WebSocket socket;
    private OkHttpClient httpClient;
    private ExecutorService encoder;
    private final AtomicBoolean encoding = new AtomicBoolean(false);
    private final AtomicLong lastFrameMs = new AtomicLong(0L);
    private PowerManager.WakeLock wakeLock;

    private static class SurfaceHolder {
        android.view.Surface surface;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CourseEra:ScreenShare");
        encoder = Executors.newSingleThreadExecutor();
        httpClient = new OkHttpClient.Builder()
                .pingInterval(15, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopCapture();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent == null || !intent.hasExtra("resultData")) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            int resultCode = intent.getIntExtra("resultCode", 0);
            Intent resultData = intent.getParcelableExtra("resultData");
            String wsUrl = intent.getStringExtra("wsUrl");

            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }

            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(30 * 60 * 1000L);
            startCapture(resultCode, resultData, wsUrl);
        } catch (Exception e) {
            stopCapture();
            stopSelf();
        }

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Keep the foreground screen-share service alive when the Course Era task is minimized/removed.
        super.onTaskRemoved(rootIntent);
    }

    private void startCapture(int resultCode, Intent resultData, String wsUrl) {
        if (resultData == null || wsUrl == null || wsUrl.isEmpty()) {
            stopSelf();
            return;
        }

        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = manager.getMediaProjection(resultCode, resultData);
        if (projection == null) {
            stopSelf();
            return;
        }

        DisplayMetrics metrics = getResources().getDisplayMetrics();
        int screenWidth = Math.min(metrics.widthPixels, 1280);
        int screenHeight = Math.max(1, Math.round(metrics.heightPixels * (screenWidth / (float) metrics.widthPixels)));
        int dpi = metrics.densityDpi;

        imageReader = ImageReader.newInstance(
                screenWidth,
                screenHeight,
                PixelFormat.RGBA_8888,
                2
        );

        surfaceHolder = new SurfaceHolder();
        surfaceHolder.surface = imageReader.getSurface();

        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopCapture();
                stopSelf();
            }
        }, null);

        virtualDisplay = projection.createVirtualDisplay(
                "CourseEraScreenShare",
                screenWidth,
                screenHeight,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                surfaceHolder.surface,
                null,
                null
        );

        imageReader.setOnImageAvailableListener(reader -> {
            long now = System.currentTimeMillis();
            if (now - lastFrameMs.get() < 180L) {
                Image skipped = reader.acquireLatestImage();
                if (skipped != null) skipped.close();
                return;
            }
            if (!encoding.compareAndSet(false, true)) {
                Image skipped = reader.acquireLatestImage();
                if (skipped != null) skipped.close();
                return;
            }

            Image image = reader.acquireLatestImage();
            if (image == null) {
                encoding.set(false);
                return;
            }

            Bitmap bitmap = null;
            try {
                Image.Plane plane = image.getPlanes()[0];
                ByteBuffer buffer = plane.getBuffer();
                int pixelStride = plane.getPixelStride();
                int rowStride = plane.getRowStride();
                int rowPadding = rowStride - pixelStride * screenWidth;
                int bitmapWidth = screenWidth + Math.max(0, rowPadding / Math.max(1, pixelStride));

                bitmap = Bitmap.createBitmap(bitmapWidth, screenHeight, Bitmap.Config.ARGB_8888);
                buffer.rewind();
                bitmap.copyPixelsFromBuffer(buffer);

                Bitmap cropped = bitmap;
                if (bitmapWidth != screenWidth) {
                    cropped = Bitmap.createBitmap(bitmap, 0, 0, screenWidth, screenHeight);
                    bitmap.recycle();
                }

                final Bitmap frameBitmap = cropped;
                lastFrameMs.set(now);
                encoder.execute(() -> {
                    try {
                        ByteArrayOutputStream out = new ByteArrayOutputStream(100 * 1024);
                        frameBitmap.compress(Bitmap.CompressFormat.JPEG, 48, out);
                        frameBitmap.recycle();

                        if (socket != null && socket.send(ByteString.of(out.toByteArray()))) {
                            // sent
                        }
                    } catch (Exception ignored) {
                    } finally {
                        encoding.set(false);
                    }
                });
            } catch (Exception ignored) {
                if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
                encoding.set(false);
            } finally {
                image.close();
            }
        }, null);

        Request request = new Request.Builder().url(wsUrl).build();
        socket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                webSocket.send("{\"type\":\"screen-start\"}");
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                stopCapture();
                stopSelf();
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                stopCapture();
                stopSelf();
            }
        });
    }

    private Notification buildNotification() {
        android.app.PendingIntent pendingIntent = android.app.PendingIntent.getActivity(
                this,
                7312,
                getPackageManager().getLaunchIntentForPackage(getPackageName()),
                Build.VERSION.SDK_INT >= 23
                        ? android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
                        : android.app.PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Course Era screen sharing")
                .setContentText("Your screen is being shared with the live class.")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Course Era screen sharing",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private synchronized void stopCapture() {
        try {
            if (socket != null) {
                socket.send("{\"type\":\"screen-stop\"}");
                socket.close(1000, "screen share stopped");
            }
        } catch (Exception ignored) {}
        socket = null;

        try { if (virtualDisplay != null) virtualDisplay.release(); } catch (Exception ignored) {}
        virtualDisplay = null;

        try { if (projection != null) projection.stop(); } catch (Exception ignored) {}
        projection = null;

        try { if (imageReader != null) imageReader.close(); } catch (Exception ignored) {}
        imageReader = null;

        if (encoder != null) {
            try { encoder.shutdownNow(); } catch (Exception ignored) {}
        }
        encoder = Executors.newSingleThreadExecutor();
        encoding.set(false);

        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    @Override
    public void onDestroy() {
        stopCapture();
        if (httpClient != null) {
            try { httpClient.dispatcher().executorService().shutdown(); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
