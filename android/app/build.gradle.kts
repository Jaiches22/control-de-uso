plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// La versión, la URL y la clave pública de Supabase llegan por variables de entorno (en GitHub Actions,
// desde el archivo VERSION y los secretos del repositorio). La firma, desde un almacén de claves que
// GitHub Actions reconstruye a partir de un secreto; sin él se firma con la clave de depuración.
val appVersion: String = System.getenv("VERSION") ?: "0.0.0"
val versionParts = appVersion.split(".").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_FILE")

android {
    namespace = "es.jaimecalzada.controldeuso"
    compileSdk = 34

    defaultConfig {
        applicationId = "es.jaimecalzada.controldeuso"
        minSdk = 29
        targetSdk = 34
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = appVersion
        buildConfigField("String", "SUPABASE_URL", "\"${System.getenv("SUPABASE_URL") ?: ""}\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"${System.getenv("SUPABASE_ANON_KEY") ?: ""}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storeType = "pkcs12"
                // La contraseña no protege nada: el almacén entero vive en un secreto de GitHub.
                storePassword = "android"
                keyAlias = "controldeuso"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (keystorePath != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
