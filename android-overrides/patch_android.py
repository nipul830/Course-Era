from pathlib import Path

gradle = Path("android/app/build.gradle")
text = gradle.read_text()
dep = 'implementation "com.squareup.okhttp3:okhttp:4.12.0"'
if dep not in text:
    text = text.replace("dependencies {", "dependencies {\n    " + dep, 1)
gradle.write_text(text)

manifest = Path("android/app/src/main/AndroidManifest.xml")
text = manifest.read_text()
if "FOREGROUND_SERVICE_MEDIA_PROJECTION" not in text:
    text = text.replace(
        "<manifest",
        '<manifest',
        1
    )
    manifest_start = text.find("<manifest")
    first_close = text.find(">", manifest_start)
    text = (
        text[:first_close + 1]
        + '\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />'
        + '\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />'
        + '\n    <uses-permission android:name="android.permission.CAMERA" />'
        + '\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />'
        + '\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'
        + '\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
        + text[first_close + 1:]
    )
    text = text.replace(
        "</application>",
        '    <service android:name=".ScreenShareService" android:exported="false" android:foregroundServiceType="mediaProjection" />\n    </application>',
        1
    )
manifest.write_text(text)
