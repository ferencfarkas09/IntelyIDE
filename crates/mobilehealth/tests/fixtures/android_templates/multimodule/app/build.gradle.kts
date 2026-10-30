plugins { alias(libs.plugins.android.application) }
android {
    namespace = "com.acme.multi"
    compileSdk = 34
    defaultConfig { applicationId = "com.acme.multi"; minSdk = 24; targetSdk = 34; versionCode = 2; versionName = "2.0" }
}
dependencies { implementation(project(":feature:login")) }
