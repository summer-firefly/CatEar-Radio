buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// Tauri plugins ship their own compileSdk (media-session pins 34), which AGP
// rejects as soon as the app module compiles against a newer platform. Lift
// every library module to the same level instead of patching the vendored
// plugin sources, which live read-only in the cargo registry. This has to run
// after each module's own `android {}` block, otherwise its value wins.
subprojects {
    afterEvaluate {
        extensions.findByType<com.android.build.gradle.LibraryExtension>()?.apply {
            compileSdk = 37
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

