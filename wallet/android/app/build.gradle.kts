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
            abiFilters.add("arm64-v8a")
        }
    }

    packaging {
        jniLibs {
            excludes += listOf(
                "lib/armeabi-v7a/**",
                "lib/armeabi/**",
                "lib/x86/**",
                "lib/x86_64/**",
            )
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

// Builds the pinned, checksum-verified libsodium.so (wallet/android/libsodium.lock.json)
// into jniLibs. A current build is reused.
val buildLibsodiumSo = tasks.register<Exec>("buildLibsodiumSo") {
    group = "shear"
    description = "Build the pinned libsodium.so into jniLibs/arm64-v8a"
    val script = rootProject.file("../../crypto/native/build-android-libsodium.sh")
    commandLine("bash", script.absolutePath)
    workingDir = rootProject.projectDir
}

// libshear_v3.so for every abiFilters ABI. The script reads those filters.
val buildShearV3So = tasks.register<Exec>("buildShearV3So") {
    group = "shear"
    description = "Cross-compile libshear_v3.so into jniLibs for every shipped ABI"
    val script = rootProject.file("../native/build-android-shear-v3.sh")
    commandLine("bash", script.absolutePath)
    workingDir = rootProject.projectDir
}

tasks.named("preBuild").configure {
    dependsOn(buildShearAdmitSo)
    dependsOn(buildLibsodiumSo)
    dependsOn(buildShearV3So)
}

dependencies {
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
