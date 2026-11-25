// PURPOSE: Build the Android kiosk with checksum-verified face and liveness model assets.
import java.net.URI
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.elt.attendance.kiosk"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.elt.attendance.kiosk"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += "arm64-v8a" }
    }
    packaging {
        jniLibs.pickFirsts += "**/libc++_shared.so"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("org.opencv:opencv:4.12.0")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
    implementation("com.google.android.play:integrity:1.6.0")
}

val zoo = "https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models"
val silentFace = "https://raw.githubusercontent.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx/584d4421d7ac42c59e640796f46e886b0095367a/onnx"
val models = mapOf(
    "yunet.onnx" to ("$zoo/face_detection_yunet/face_detection_yunet_2023mar.onnx" to "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    "sface.onnx" to ("$zoo/face_recognition_sface/face_recognition_sface_2021dec.onnx" to "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
    "minifasnet-v2.onnx" to ("$silentFace/2.7_80x80_MiniFASNetV2.onnx" to "0cbe5caec95c31de9d2ef845cb85407d76aecd1b6a2c0e343f7d35306bfbccb8"),
    "minifasnet-v1se.onnx" to ("$silentFace/4_0_0_80x80_MiniFASNetV1SE.onnx" to "a25886a85cdcfa2c4ea23edb71de35f250c17827b4cadd253a972b28c80fdf1e"),
)
val modelAssets = layout.buildDirectory.dir("model-assets")
val prepareModels by tasks.registering {
    inputs.property("modelVersions", models.mapValues { it.value.second })
    outputs.dir(modelAssets)
    doLast {
        fun digest(file: File): String {
            val sha256 = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { stream ->
                val buffer = ByteArray(8192)
                while (true) {
                    val bytes = stream.read(buffer)
                    if (bytes < 0) break
                    sha256.update(buffer, 0, bytes)
                }
            }
            return sha256.digest().joinToString("") { "%02x".format(it) }
        }

        val directory = modelAssets.get().asFile.apply { mkdirs() }
        for ((name, source) in models) {
            val (url, expected) = source
            val target = directory.resolve(name)
            if (target.isFile && digest(target) == expected) continue
            val temporary = File.createTempFile(name, ".download", directory)
            try {
                val connection = URI(url).toURL().openConnection().apply {
                    connectTimeout = 15000
                    readTimeout = 60000
                }
                connection.getInputStream().use { input ->
                    temporary.outputStream().use { output -> input.copyTo(output) }
                }
                check(digest(temporary) == expected) { "Unexpected SHA-256 for $name" }
                temporary.copyTo(target, overwrite = true)
            } finally {
                temporary.delete()
            }
        }
    }
}
android.sourceSets.named("main") { assets.srcDir(modelAssets) }
tasks.named("preBuild") { dependsOn(prepareModels) }
