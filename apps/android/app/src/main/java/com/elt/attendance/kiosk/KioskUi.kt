// PURPOSE: Kiosk palette, drawn icons, and the camera face guide shared by KioskActivity's screens.
package com.elt.attendance.kiosk

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.view.View
import androidx.core.graphics.PathParser
import kotlin.math.max

internal object Palette {
    val orange = Color.rgb(255, 99, 48)
    val orangeLight = Color.rgb(255, 140, 82)
    val orangeSoft = Color.rgb(253, 233, 225)
    val orangeDisabled = Color.rgb(250, 192, 170)
    val ink = Color.rgb(26, 25, 23)
    val muted = Color.rgb(107, 102, 96)
    val line = Color.rgb(234, 226, 220)
    val idleDot = Color.rgb(217, 213, 209)
    val green = Color.rgb(30, 150, 80)
    val greenDot = Color.rgb(74, 210, 120)
    val greenSoft = Color.rgb(226, 245, 233)
    val greenGuide = Color.rgb(52, 211, 110)
    /** Punch scan in progress: calm "working" colour, so people don't read it as an error and re-adjust. */
    val scanYellow = Color.rgb(255, 204, 0)
    val peachTop = Color.rgb(252, 214, 199)
    val peachBottom = Color.rgb(255, 247, 243)
}

/** Material icon path data on a 24×24 viewport. */
internal object Icons {
    const val LOGIN = "M11,7L9.6,8.4l2.6,2.6H2v2h10.2l-2.6,2.6L11,17l5-5L11,7z M20,19h-8v2h8c1.1,0,2-0.9,2-2V5c0-1.1-0.9-2-2-2h-8v2h8V19z"
    const val LOGOUT = "M17,7l-1.41,1.41L18.17,11H8v2h10.17l-2.58,2.58L17,17l5-5L17,7z M4,5h8V3H4C2.9,3,2,3.9,2,5v14c0,1.1,0.9,2,2,2h8v-2H4V5z"
    const val PERSON = "M12,12c2.21,0,4-1.79,4-4s-1.79-4-4-4-4,1.79-4,4 1.79,4 4,4z M12,14c-2.67,0-8,1.34-8,4v2h16v-2c0-2.66-5.33-4-8-4z"
    const val CHECK = "M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41-1.41z"
    const val INFO = "M11,7h2v2h-2z M11,11h2v6h-2z M12,2C6.48,2,2,6.48,2,12s4.48,10,10,10 10-4.48,10-10S17.52,2,12,2z M12,20c-4.41,0-8-3.59-8-8s3.59-8,8-8 8,3.59,8,8-3.59,8-8,8z"
    const val CAMERA_OFF = "M21,6.5l-4,4V7c0-0.55-0.45-1-1-1H9.82L21,17.18V6.5z M3.27,2L2,3.27 4.73,6H4c-0.55,0-1,0.45-1,1v10c0,0.55,0.45,1,1,1h12c0.21,0,0.39-0.08,0.54-0.18L19.73,21 21,19.73 3.27,2z"
    const val BACKSPACE = "M22,3H7C6.31,3,5.77,3.35,5.41,3.88L0,12l5.41,8.11C5.77,20.64,6.31,21,7,21h15c1.1,0,2-0.9,2-2V5C24,3.9,23.1,3,22,3z M19,15.59L17.59,17 14,13.41 10.41,17 9,15.59 12.59,12 9,8.41 10.41,7 14,10.59 17.59,7 19,8.41 15.41,12 19,15.59z"
}

internal fun rounded(fill: Int, radius: Float, stroke: Int = 0, strokeWidth: Int = 0) = GradientDrawable().apply {
    setColor(fill)
    cornerRadius = radius
    if (strokeWidth > 0) setStroke(strokeWidth, stroke)
}

internal fun oval(fill: Int, sizePx: Int = -1) = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(fill)
    if (sizePx > 0) setSize(sizePx, sizePx)
}

internal abstract class FlatDrawable(private val sizePx: Int) : Drawable() {
    protected val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun getIntrinsicWidth() = sizePx
    override fun getIntrinsicHeight() = sizePx
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter = filter }
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

internal class IconDrawable(data: String, tint: Int, sizePx: Int) : FlatDrawable(sizePx) {
    private val source = PathParser.createPathFromPathData(data)
    private val scaled = Path()
    private val matrix = Matrix()

    init { paint.color = tint }

    override fun draw(canvas: Canvas) {
        matrix.setScale(bounds.width() / 24f, bounds.height() / 24f)
        matrix.postTranslate(bounds.left.toFloat(), bounds.top.toFloat())
        source.transform(matrix, scaled)
        canvas.drawPath(scaled, paint)
    }
}

/** Concentric open arcs that read as a fingerprint at icon size. */
internal class FingerprintDrawable(tint: Int, sizePx: Int) : FlatDrawable(sizePx) {
    init {
        paint.color = tint
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
    }

    override fun draw(canvas: Canvas) {
        val w = bounds.width().toFloat()
        paint.strokeWidth = w * .06f
        val cx = bounds.exactCenterX()
        val cy = bounds.top + w * .55f
        val arcs = listOf(.08f to (180f to 180f), .18f to (160f to 220f), .29f to (150f to 240f), .4f to (195f to 150f))
        for ((radius, sweep) in arcs) {
            val r = w * radius
            canvas.drawArc(cx - r, cy - r, cx + r, cy + r * 1.2f, sweep.first, sweep.second, false, paint)
        }
    }
}

/** Oval the employee lines their face up with over the live preview; it also judges where a detected face sits. */
internal class FaceGuideView(context: Context) : View(context) {
    enum class Fit { NONE, MANY, OFF_CENTER, TOO_FAR, TOO_CLOSE, OK }
    /** On-camera cue drawn around the oval: a pulse to hold still, or chevrons streaming the way to move. */
    enum class Gesture { NONE, STRAIGHT, LEFT, RIGHT, UP, DOWN }

    private val density = context.resources.displayMetrics.density
    private val cue = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = 5 * density
        color = Color.WHITE
    }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = 6 * density
    }
    private val chevron = Path()

    var gesture = Gesture.NONE
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }
    /** Progress segments around the oval; 0 hides the ring. */
    var steps = 0
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }
    var completed = 0
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 4 * context.resources.displayMetrics.density
        color = Palette.orange
    }
    var tint: Int = Palette.orange
        set(value) {
            if (field == value) return
            field = value
            paint.color = value
            invalidate()
        }

    // Read from the camera analysis thread.
    @Volatile private var viewWidth = 0f
    @Volatile private var viewHeight = 0f

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        viewWidth = w.toFloat()
        viewHeight = h.toFloat()
    }

    /** Breathes while looking for a face; holds still once one is placed. Drawing only, [fit] uses the resting oval. */
    var searching = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    private fun oval(width: Float, height: Float): RectF {
        // Drawn larger than the liveness target; [fit]'s size window is scaled by OVAL_SCALE so the face still lands at
        // ~25% of the analysed frame. Retune both if the camera crop or the liveness crop scales (2.7 / 4.0) change.
        val w = width * OVAL_WIDTH
        val h = w * 1.32f
        val cx = width / 2f
        val cy = height * .4f
        return RectF(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    }

    override fun onDraw(canvas: Canvas) {
        val o = oval(width.toFloat(), height.toFloat())
        if (searching && steps == 0) {
            val breath = (kotlin.math.sin(android.os.SystemClock.uptimeMillis() / 420.0) * .025).toFloat()
            canvas.drawOval(RectF(o).apply { inset(-width() * breath, -height() * breath) }, paint)
            postInvalidateOnAnimation()
        } else {
            canvas.drawOval(o, paint)
        }
        if (steps > 0) {
            val track = RectF(o).apply { inset(-14 * density, -14 * density) }
            val slice = 360f / steps
            for (index in 0 until steps) {
                ring.color = if (index < completed) Palette.greenGuide else Color.argb(90, 255, 255, 255)
                canvas.drawArc(track, -90f + index * slice + 4f, slice - 8f, false, ring)
            }
        }
        if (gesture == Gesture.NONE) return
        val phase = (android.os.SystemClock.uptimeMillis() % 1100) / 1100f
        if (gesture == Gesture.STRAIGHT) {
            val grow = phase * 22 * density
            cue.alpha = ((1 - phase) * 200).toInt()
            canvas.drawOval(RectF(o).apply { inset(-grow - 26 * density, -grow - 26 * density) }, cue)
        } else {
            val (dx, dy) = when (gesture) {
                Gesture.LEFT -> -1f to 0f
                Gesture.RIGHT -> 1f to 0f
                Gesture.UP -> 0f to -1f
                else -> 0f to 1f
            }
            val ax = if (dx != 0f) (if (dx < 0) o.left else o.right) else o.centerX()
            val ay = if (dy != 0f) (if (dy < 0) o.top else o.bottom) else o.centerY()
            val size = 13 * density
            val spacing = 20 * density
            for (index in 0..2) {
                val travel = index + phase
                val reach = 30 * density + travel * spacing
                val tx = ax + dx * reach
                val ty = ay + dy * reach
                cue.alpha = ((1 - travel / 3f) * 255).toInt().coerceIn(0, 255)
                chevron.reset()
                chevron.moveTo(tx - dx * size - dy * size, ty - dy * size + dx * size)
                chevron.lineTo(tx, ty)
                chevron.lineTo(tx - dx * size + dy * size, ty - dy * size - dx * size)
                canvas.drawPath(chevron, cue)
            }
        }
        postInvalidateOnAnimation()
    }

    /**
     * Maps the analysed frame onto this view (the preview fills and centre-crops the same 4:3 stream, mirrored for the
     * front camera) and says whether the face sits centred in the oval at a size the liveness check accepts.
     * [loose] widens the window for head turns during enrollment.
     */
    fun fit(tracked: Tracked, loose: Boolean = false): Fit {
        val face = tracked.face ?: return if (tracked.faces > 1) Fit.MANY else Fit.NONE
        val width = viewWidth
        val height = viewHeight
        if (width <= 0f || height <= 0f) return Fit.NONE
        val scale = max(width / tracked.width, height / tracked.height)
        val dx = (width - tracked.width * scale) / 2
        val dy = (height - tracked.height * scale) / 2
        val cx = width - (dx + (face[0] + face[2] / 2) * scale)
        val cy = dy + (face[1] + face[3] / 2) * scale
        val o = oval(width, height)
        val nx = (cx - o.centerX()) / (o.width() / 2) * OVAL_SCALE
        val ny = (cy - o.centerY()) / (o.height() / 2) * OVAL_SCALE
        val reach = if (loose) .55f else .32f
        if (nx * nx + ny * ny > reach * reach) return Fit.OFF_CENTER
        // ponytail: size window as a share of the oval width; calibration knob alongside the oval size.
        val ratio = face[2] * scale / o.width() * OVAL_SCALE
        if (ratio < (if (loose) .55f else .66f)) return Fit.TOO_FAR
        if (ratio > (if (loose) 1.1f else .98f)) return Fit.TOO_CLOSE
        return Fit.OK
    }

    private companion object {
        // ponytail: 0.42 of the view width is the liveness-calibrated size; OVAL_WIDTH is only how large it is drawn.
        const val OVAL_WIDTH = .58f
        const val OVAL_SCALE = OVAL_WIDTH / .42f
    }
}
