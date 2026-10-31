package io.github.kahme247.ompweb

import android.app.Application

class OmpWebApplication : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
