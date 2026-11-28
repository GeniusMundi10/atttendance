// PURPOSE: Play packaged kiosk prompts on the media stream with a single active utterance.
package com.elt.attendance.kiosk

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.view.accessibility.AccessibilityManager
import java.util.Locale

/** Main-thread player. Camera guidance never interrupts a workflow prompt or result. */
internal class KioskVoicePlayer(private val context: Context) {
    private val accessibility = context.getSystemService(AccessibilityManager::class.java)
    private val touchExploration = AccessibilityManager.TouchExplorationStateChangeListener { enabled ->
        if (enabled) stop()
    }
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val resources = mutableMapOf<VoiceCue, Int>()
    private var player: MediaPlayer? = null
    private var playingCameraCue = false

    init {
        accessibility?.addTouchExplorationStateChangeListener(touchExploration)
    }

    fun play(cue: VoiceCue, camera: Boolean = false) {
        if (accessibility?.isTouchExplorationEnabled == true || (camera && player != null && !playingCameraCue)) return
        val resource = resources.getOrPut(cue) { findResource(cue) }
        if (resource == 0) return
        stop()
        try {
            val next = MediaPlayer.create(context, resource, attributes, AudioManager.AUDIO_SESSION_ID_GENERATE) ?: return
            player = next
            playingCameraCue = camera
            next.setOnCompletionListener { completed -> if (player === completed) stop() }
            next.setOnErrorListener { failed, _, _ ->
                if (player === failed) stop()
                true
            }
            next.start()
        } catch (_: RuntimeException) {
            stop()
        }
    }

    fun stopCamera() {
        if (playingCameraCue) stop()
    }

    fun stop() {
        val previous = player
        player = null
        playingCameraCue = false
        previous?.release()
    }

    fun close() {
        accessibility?.removeTouchExplorationStateChangeListener(touchExploration)
        stop()
    }

    @SuppressLint("DiscouragedApi") // Local UI builds can omit the generated audio resources.
    private fun findResource(cue: VoiceCue): Int = context.resources.getIdentifier(
        "voice_${cue.name.lowercase(Locale.ROOT)}", "raw", context.packageName,
    )
}
