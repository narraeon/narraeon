import groovy.json.JsonSlurper
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app version follows the root package.json, so the APK and the npm package
// report the same version. versionCode packs major/minor/patch (prerelease suffixes
// are ignored): 0.6.0 -> 600. Patch numbers must stay below 100.
val packageVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val semver = Regex("""^(\d+)\.(\d+)\.(\d+)""").find(packageVersion)
    ?: throw GradleException("package.json version is not SemVer: $packageVersion")
val (versionMajor, versionMinor, versionPatch) = semver.destructured

val keystoreBase64 = System.getenv("ANDROID_KEYSTORE_BASE64")?.takeIf { it.isNotBlank() }
val envKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
val envKeyAlias = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val envKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
val missingReleaseSigning = listOf(
    "ANDROID_KEYSTORE_BASE64" to keystoreBase64,
    "ANDROID_KEYSTORE_PASSWORD" to envKeystorePassword,
    "ANDROID_KEY_ALIAS" to envKeyAlias,
    "ANDROID_KEY_PASSWORD" to envKeyPassword,
).filter { it.second == null }.map { it.first }
val releaseSigningReady = missingReleaseSigning.isEmpty()
val releaseKeystoreFile = layout.buildDirectory.file("signing/release.keystore").get().asFile
if (releaseSigningReady) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getMimeDecoder().decode(keystoreBase64!!))
}

val checkReleaseSigning = tasks.register("checkReleaseSigningCredentials") {
    val missing = missingReleaseSigning.joinToString()
    doLast {
        if (missing.isNotEmpty()) {
            throw GradleException("Missing Android release signing environment variables: $missing")
        }
    }
}

// Validate before building the release APK or bundle. Debug and release tests can run independently.
tasks.configureEach {
    when (name) {
        "packageRelease", "packageReleaseBundle" -> dependsOn(checkReleaseSigning)
        "preReleaseBuild" -> mustRunAfter(checkReleaseSigning)
    }
}

android {
    namespace = "app.narraeon.android"
    ndkVersion = "26.3.11579264"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.narraeon.android"
        minSdk = 24
        targetSdk = 34
        versionCode = versionMajor.toInt() * 10000 + versionMinor.toInt() * 100 + versionPatch.toInt()
        versionName = packageVersion

        ndk {
            // libnode.so ships for arm64 only; see android/scripts/fetch-libnode.sh.
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++20"
                // libnode.so links libc++_shared.so, so the app must ship it too.
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
        }
    }

    signingConfigs {
        create("release") {
            if (releaseSigningReady) {
                storeFile = releaseKeystoreFile
                storePassword = envKeystorePassword
                this.keyAlias = envKeyAlias
                keyPassword = envKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (releaseSigningReady) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    testImplementation("junit:junit:4.13.2")
}
