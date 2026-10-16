import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keyPropertiesFile = rootProject.file("key.properties")
val keyProperties = Properties()
val hasReleaseKey = keyPropertiesFile.exists()
if (hasReleaseKey) {
    keyPropertiesFile.inputStream().use { stream -> keyProperties.load(stream) }
}

android {
    namespace = "com.shear.shear_wallet"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.shear.shear_wallet"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 29
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        ndk {
            abiFilters.clear()
            abiFilters.add("armeabi-v7a")
            abiFilters.add("arm64-v8a")
            abiFilters.add("x86")
            abiFilters.add("x86_64")
        }
    }

    // minSdk 29 still compresses jniLibs into the APK unless this is set.
    // The loader reads the extracted file beside libflutter.so, before dlopen.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    // Release APKs are signed with Russell's offline Continuum key.
    // libshear_admit.so is gitignored and is covered by that APK signature,
    // not by a hash inside the Dart snapshot.
    signingConfigs {
        create("release") {
            if (hasReleaseKey) {
                storeFile = file(keyProperties.getProperty("storeFile") ?: "")
                storePassword = keyProperties.getProperty("storePassword")
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseKey) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

gradle.taskGraph.whenReady {
    val releasing = allTasks.any { task ->
        val name = task.name
        name.contains("Release", ignoreCase = true) &&
            (name.startsWith("assemble") || name.startsWith("bundle") || name.contains("Package"))
    }
    if (releasing && !hasReleaseKey) {
        throw GradleException(
            "Missing wallet/android/key.properties. Release assemble refuses the debug cert. " +
                "Provide storePassword, keyPassword, keyAlias=continuum, and storeFile for the Continuum release keystore."
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// Packages libshear_admit.so for arm64-v8a. The script cross-compiles the
// cdylib; jniLibs is the Android linker input. iOS uses a staticlib instead.
val buildShearAdmitSo = tasks.register<Exec>("buildShearAdmitSo") {
    group = "shear"
    description = "Cross-compile libshear_admit.so into jniLibs/arm64-v8a"
    val script = rootProject.file("../../crypto/native/build-android-arm64.sh")
    commandLine("bash", script.absolutePath)
    workingDir = rootProject.projectDir
}

val buildShearHashSo = tasks.register<Exec>("buildShearHashSo") {
    group = "shear"
    description = "Cross-compile libshearhash.so for every shipped ABI"
    val script = rootProject.file("../../crypto/native/build-shearhash-android.sh")
    commandLine("bash", script.absolutePath)
    workingDir = rootProject.projectDir
}

val checkShearHashPins = tasks.register<Exec>("checkShearHashPins") {
    group = "shear"
    description = "Every shipped ABI libshearhash.so matches its pin"
    dependsOn(buildShearHashSo)
    val script = rootProject.file("../../crypto/native/check_shearhash_android_pins.py")
    val jni = file("src/main/jniLibs")
    commandLine("python3", script.absolutePath, "--jni", jni.absolutePath)
    workingDir = rootProject.projectDir
}

tasks.named("preBuild").configure {
    dependsOn(buildShearAdmitSo, buildShearHashSo, checkShearHashPins)
}

dependencies {
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
