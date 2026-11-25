// PURPOSE: Resolve kiosk dependencies from official Maven repositories.
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "ELT Attendance Kiosk"
include(":app")
