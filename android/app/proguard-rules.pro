# R8 rules for the release build. Debug builds do not run R8, so every rule
# here exists for minified builds only; verify changes with `assembleRelease`
# plus a live smoke test (Mermaid, images, chat) on a device.
#
# kotlinx.serialization ships consumer rules for its generated serializers;
# the app calls serializer() explicitly, so no keep rule for model classes is
# needed. Keep the metadata the library reflects on.
-keepattributes *Annotation*, InnerClasses, Signature
-dontnote kotlinx.serialization.**

# OkHttp ships the needed rules in its own artifact; it probes optional TLS
# providers that are not on the classpath.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Mermaid renders inside a sandboxed WebView and calls back through a bridge
# object that is only reachable from JavaScript. R8 cannot see those calls and
# would otherwise strip or rename postMessage().
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Coil resolves decoders/fetchers through ServiceLoader next to the ones the
# app registers explicitly (SVG + OkHttp). Keep both extensions intact; both
# are small and reach into androidx/androidsvg plumbing.
-keep class coil3.svg.** { *; }
-keep class coil3.network.okhttp.** { *; }
-dontwarn coil3.**

# Compose and its runtime ship consumer rules. The app owns no reflective
# entry points besides the WebView bridge above.
