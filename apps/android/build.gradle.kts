// PURPOSE: Pin the Android and Kotlin build plugins for the kiosk app.
plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.3.21" apply false
}
