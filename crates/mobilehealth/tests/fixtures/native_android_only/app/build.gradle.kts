plugins {
    id("com.android.application")
}

android {
    namespace = "com.acme.native"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.acme.native"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "0.3.0"
    }
}
