// PURPOSE: Run YuNet detection, SFace matching, and MiniVision liveness on camera frames.
package com.elt.attendance.kiosk

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import androidx.camera.core.ImageProxy
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.core.Core
import org.opencv.core.Mat
import org.opencv.core.Rect
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import org.opencv.objdetect.FaceDetectorYN
import org.opencv.objdetect.FaceRecognizerSF
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

internal data class Sample(val embedding: FloatArray, val liveness: Int)
internal class CaptureRejected(val displayMessage: String) : IllegalStateException("Camera capture rejected")

internal fun normalized(vector: FloatArray): FloatArray {
    require(vector.size == 128 && vector.all { it.isFinite() })
    val norm = sqrt(vector.sumOf { it.toDouble() * it })
    require(norm > 1e-6)
    return FloatArray(vector.size) { vector[it] / norm.toFloat() }
}

internal fun similarity(first: FloatArray, second: FloatArray): Double =
    first.indices.sumOf { first[it].toDouble() * second[it] }.coerceIn(-1.0, 1.0)

internal class FaceEngine(context: Context) : AutoCloseable {
    init { check(OpenCVLoader.initLocal()) { "OpenCV runtime unavailable" } }

    private val detector = FaceDetectorYN.create(assetFile(context, "yunet.onnx"), "", Size(320.0, 320.0), 0.70f, 0.3f, 5000)
    private val recognizer = FaceRecognizerSF.create(assetFile(context, "sface.onnx"), "")
    private val ort = OrtEnvironment.getEnvironment()
    private val v2 = loadLiveness(context, "minifasnet-v2.onnx")
    private val v1se = try {
        loadLiveness(context, "minifasnet-v1se.onnx")
    } catch (failure: Exception) {
        v2.close()
        throw failure
    }

    private fun loadLiveness(context: Context, asset: String): OrtSession =
        context.assets.open(asset).use { input ->
            OrtSession.SessionOptions().use { options ->
                options.setIntraOpNumThreads(2)
                ort.createSession(input.readBytes(), options)
            }
        }

    fun inspect(image: ImageProxy): Sample? {
        val bitmap = image.toBitmap()
        val rgba = Mat()
        val bgr = Mat()
        val faces = Mat()
        try {
            Utils.bitmapToMat(bitmap, rgba)
            Imgproc.cvtColor(rgba, bgr, Imgproc.COLOR_RGBA2BGR)
            when (image.imageInfo.rotationDegrees) {
                0 -> Unit
                90 -> Core.rotate(bgr, bgr, Core.ROTATE_90_CLOCKWISE)
                180 -> Core.rotate(bgr, bgr, Core.ROTATE_180)
                270 -> Core.rotate(bgr, bgr, Core.ROTATE_90_COUNTERCLOCKWISE)
                else -> error("Unexpected camera rotation")
            }
            detector.setInputSize(bgr.size())
            detector.detect(bgr, faces)
            if (faces.empty()) return null
            if (faces.rows() != 1) throw CaptureRejected("Only one person can be in view.")

            val face = FloatArray(15)
            faces.get(0, 0, face)
            if (face.any { !it.isFinite() } || face[14] < .9f || !goodBounds(face, bgr)) {
                throw CaptureRejected("Center your face in the camera and move closer.")
            }
            val first = liveness(v2, bgr, face, 2.7)
            val second = liveness(v1se, bgr, face, 4.0)
            if (min(first, second) < .90) {
                throw CaptureRejected("Live face check failed. Try again in even light.")
            }
            val aligned = Mat()
            val raw = Mat()
            try {
                recognizer.alignCrop(bgr, faces, aligned)
                recognizer.feature(aligned, raw)
                val vector = FloatArray(128)
                require(raw.rows() == 1 && raw.cols() == vector.size)
                raw.get(0, 0, vector)
                return Sample(normalized(vector), (min(first, second) * 10000).roundToInt())
            } finally {
                aligned.release()
                raw.release()
            }
        } finally {
            faces.release()
            bgr.release()
            rgba.release()
            bitmap.recycle()
        }
    }

    private fun goodBounds(face: FloatArray, image: Mat): Boolean {
        val (x, y, w, h) = face
        return x >= 2 && y >= 2 && x + w <= image.cols() - 2 && y + h <= image.rows() - 2 &&
            w >= maxOf(75f, image.cols() * .20f) && h >= 85f
    }

    private fun liveness(model: OrtSession, image: Mat, face: FloatArray, modelScale: Double): Double {
        val (x, y, w, h) = face
        val scale = minOf(modelScale, image.cols() / w.toDouble(), image.rows() / h.toDouble())
        val width = (w * scale).roundToInt().coerceIn(1, image.cols())
        val height = (h * scale).roundToInt().coerceIn(1, image.rows())
        val left = (x + w / 2 - width / 2.0).roundToInt().coerceIn(0, image.cols() - width)
        val top = (y + h / 2 - height / 2.0).roundToInt().coerceIn(0, image.rows() - height)
        val crop = image.submat(Rect(left, top, width, height))
        val resized = Mat()
        try {
            Imgproc.resize(crop, resized, Size(80.0, 80.0))
            val plane = 80 * 80
            val pixels = ByteArray(3 * plane)
            resized.get(0, 0, pixels)
            // Upstream MiniVision ToTensor uses BGR float values in the 0–255 range.
            val input = FloatArray(3 * plane)
            for (channel in 0..2) {
                for (pixel in 0 until plane) input[channel * plane + pixel] = (pixels[pixel * 3 + channel].toInt() and 255).toFloat()
            }
            OnnxTensor.createTensor(ort, FloatBuffer.wrap(input), longArrayOf(1, 3, 80, 80)).use { tensor ->
                model.run(mapOf("input" to tensor)).use { output ->
                    val scores = (output.get(0).value as Array<*>).single() as FloatArray
                    require(scores.size == 3 && scores.all { it.isFinite() })
                    val maximum = scores.max()
                    return exp((scores[1] - maximum).toDouble()) / scores.sumOf { exp((it - maximum).toDouble()) }
                }
            }
        } finally {
            resized.release()
            crop.release()
        }
    }

    override fun close() {
        v2.close()
        v1se.close()
    }

    private companion object {
        fun assetFile(context: Context, name: String): String {
            val directory = File(context.codeCacheDir, "elt-models-v1").apply { mkdirs() }
            val target = File(directory, name)
            if (!target.isFile) {
                val temporary = File.createTempFile(name, ".pending", directory)
                try {
                    context.assets.open(name).use { input ->
                        temporary.outputStream().use { output -> input.copyTo(output) }
                    }
                    check(temporary.renameTo(target) || target.isFile)
                } finally {
                    temporary.delete()
                }
            }
            return target.absolutePath
        }
    }
}
