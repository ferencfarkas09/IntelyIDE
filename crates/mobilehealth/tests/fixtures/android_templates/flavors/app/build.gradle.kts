plugins { id("com.android.application") }
android {
    namespace = "com.acme.flav"
    compileSdk = 34
    defaultConfig { applicationId = "com.acme.flav"; minSdk = 24; targetSdk = 34; versionCode = 1; versionName = "1.0" }
    flavorDimensions += "tier"
    productFlavors {
        create("free") { dimension = "tier"; applicationIdSuffix = ".free" }
        create("paid") { dimension = "tier" }
    }
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("FLAV_KEYSTORE") ?: "release.jks")
            storePassword = System.getenv("FLAV_STORE_PASSWORD")
            keyAlias = "flav"
            keyPassword = System.getenv("FLAV_KEY_PASSWORD")
        }
    }
    buildTypes { release { signingConfig = signingConfigs.getByName("release") } }
}
