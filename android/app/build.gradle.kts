import java.io.File
import java.util.Properties
import org.gradle.api.tasks.testing.Test
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing is opt-in: point OMPWEB_SIGNING_PROPERTIES at a properties
// file with storeFile, storePassword, keyAlias and keyPassword. Without it,
// release builds stay unsigned and are only useful for compile checks.
val signingPropertiesPath: String? = System.getenv("OMPWEB_SIGNING_PROPERTIES")
val releaseSigning = signingPropertiesPath?.takeIf { it.isNotBlank() }?.let { path ->
    val file = File(path)
    require(file.isFile) { "OMPWEB_SIGNING_PROPERTIES points at a missing file: $path" }
    Properties().apply { file.inputStream().use(::load) }
}

// One place for the release version. versionCode scheme:
// MAJOR * 10000 + MINOR * 100 + PATCH (1.0.11 -> 10011). It is a monotonically
// increasing integer, never reused, so every release installs over the
// previous one. The update server's latest.json sidecar is generated from
// these two values by writeReleaseSidecar.
val ompWebVersionName = "1.0.17"
val ompWebVersionCode = 10017

android {
    namespace = "io.github.kahme247.ompweb"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "io.github.kahme247.ompweb"
        minSdk = 26
        targetSdk = 37
        versionCode = ompWebVersionCode
        versionName = ompWebVersionName
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (releaseSigning != null) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = File(releaseSigning.getProperty("storeFile"))
                    storePassword = releaseSigning.getProperty("storePassword")
                    keyAlias = releaseSigning.getProperty("keyAlias")
                    keyPassword = releaseSigning.getProperty("keyPassword")
                }
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    testOptions {
        unitTests {
            // Robolectric JPEG/PNG-backed Compose screenshots need the merged
            // resources and manifest of the debug variant on the test classpath.
            isIncludeAndroidResources = true
        }
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

// Name the release APK after the version and write the sidecar the internal
// update feed (`latest.json`) derives versionName/versionCode from. Both live
// next to the APK under build/outputs/apk/release/.
androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        variant.outputs.forEach { output ->
            output.outputFileName.set("ompweb-$ompWebVersionName.apk")
        }
    }
}

val writeReleaseSidecar = tasks.register("writeReleaseSidecar") {
    group = "build"
    description = "Writes ompweb-<version>.apk.json next to the release APK."
    val outputDirectory = layout.buildDirectory.dir("outputs/apk/release")
    outputs.file(outputDirectory.map { it.file("ompweb-$ompWebVersionName.apk.json") })
    doLast {
        val sidecar = outputDirectory.get().file("ompweb-$ompWebVersionName.apk.json").asFile
        sidecar.parentFile.mkdirs()
        sidecar.writeText(
            "{\"versionName\":\"$ompWebVersionName\",\"versionCode\":$ompWebVersionCode}\n",
        )
    }
}

tasks.matching { it.name == "assembleRelease" }.configureEach {
    finalizedBy(writeReleaseSidecar)
}

// ---------------------------------------------------------------- screenshots
//
// The hardening matrix renders composables through Robolectric's native Skia
// backend and compares the pixels against committed goldens under
// app/src/test/screenshots/. `verifyScreenshots` is a gate task; a normal
// `testDebugUnitTest` run verifies too. `recordScreenshots` rewrites the
// goldens (or set OMPWEB_SCREENSHOT_RECORD=1 / -Pscreenshot.record=true).
val screenshotFilter = "io.github.kahme247.ompweb.screenshot.*"
val requestedTasks = gradle.startParameter.taskNames.map { it.substringAfterLast(':') }
val screenshotTasksRequested = requestedTasks.any { it == "verifyScreenshots" || it == "recordScreenshots" }
val screenshotRecordingRequested = requestedTasks.contains("recordScreenshots")

tasks.withType<Test>().configureEach {
    val record = when {
        screenshotTasksRequested -> screenshotRecordingRequested
        else -> providers.gradleProperty("screenshot.record").orNull == "true" ||
            System.getenv("OMPWEB_SCREENSHOT_RECORD") == "1"
    }
    systemProperty("ompweb.screenshot.record", record.toString())
    if (screenshotTasksRequested) {
        filter { includeTestsMatching(screenshotFilter) }
    }
    // Robolectric's native graphics runtime reflects into these packages on
    // JDK 17+; without the opens/exports flags it aborts before the first
    // render (SharedSecrets is needed for the app file descriptors).
    jvmArgs(
        "--add-opens=java.base/java.io=ALL-UNNAMED",
        "--add-opens=java.base/java.lang=ALL-UNNAMED",
        "--add-opens=java.base/java.util=ALL-UNNAMED",
        "--add-opens=java.base/jdk.internal.access=ALL-UNNAMED",
        "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
    )
    maxHeapSize = "3g"
}

tasks.register("verifyScreenshots") {
    group = "verification"
    description = "Verifies the golden screenshot matrix (JVM, no device)."
    dependsOn(tasks.named("testDebugUnitTest"))
}

tasks.register("recordScreenshots") {
    group = "verification"
    description = "Records/updates the golden screenshots from the current UI."
    dependsOn(tasks.named("testDebugUnitTest"))
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.core.splashscreen)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.material3.adaptive.navigation)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.coil.svg)
    implementation(libs.latex.renderer)
    implementation(libs.latex.fonts.katex)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.browser)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
